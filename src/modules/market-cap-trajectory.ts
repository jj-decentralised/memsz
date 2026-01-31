/**
 * Module 2: Market Cap Trajectory Analysis
 *
 * For each discovered token, fetches historical OHLCV data and computes:
 * - Whether it ever crossed $10M market cap
 * - When it first crossed
 * - How long it stayed above
 * - Peak market cap
 * - Current status
 *
 * Approach: Use getBars with daily resolution, multiply close price by
 * current supply to estimate historical market cap.
 *
 * Known limitation: Uses current supply for all historical points since
 * Codex.io does not provide historical supply data.
 */

import type { GraphQLClient } from "graphql-request";
import type {
  CodexConfig,
  TokenInfo,
  MarketCapTrajectory,
  OHLCVBar,
} from "../types/index.js";
import { QUERIES, rateLimitedQuery } from "../client/codex.js";
import {
  toUnixSeconds,
  barSymbol,
  SOLANA_DATA_START,
} from "../utils/helpers.js";

interface BarsResponse {
  getBars: {
    o: number[];
    h: number[];
    l: number[];
    c: number[];
    v: number[];
    t: number[];
    s: string;
  };
}

async function fetchDailyBars(
  client: GraphQLClient,
  pairAddress: string,
  networkId: number
): Promise<OHLCVBar[]> {
  const from = toUnixSeconds(SOLANA_DATA_START);
  const to = toUnixSeconds(new Date());
  const symbol = barSymbol(pairAddress, networkId);

  const data = await rateLimitedQuery<BarsResponse>(client, QUERIES.GET_BARS, {
    symbol,
    from,
    to,
    resolution: "1D",
  });

  if (data.getBars.s !== "ok" || !data.getBars.t.length) {
    return [];
  }

  return data.getBars.t.map((t, i) => ({
    timestamp: t,
    open: data.getBars.o[i],
    high: data.getBars.h[i],
    low: data.getBars.l[i],
    close: data.getBars.c[i],
    volume: data.getBars.v[i],
  }));
}

/**
 * Derive the effective supply multiplier from Codex's own market cap / price.
 * This is decimal-adjusted (unlike raw on-chain circulatingSupply/totalSupply
 * which are in smallest units and would inflate market cap by 10^decimals).
 */
function getSupplyMultiplier(token: TokenInfo): number {
  // Codex already computes marketCap = decimal-adjusted supply × price
  // So marketCap / price gives the correct supply to use with historical prices
  if (token.priceUsd > 0 && token.marketCapUsd > 0) {
    return token.marketCapUsd / token.priceUsd;
  }
  return 0;
}

export async function analyzeTrajectory(
  client: GraphQLClient,
  token: TokenInfo,
  config: CodexConfig
): Promise<MarketCapTrajectory> {
  const result: MarketCapTrajectory = {
    tokenAddress: token.address,
    symbol: token.symbol,
    reachedThreshold: false,
    firstCrossTimestamp: null,
    currentlyAbove: false,
    daysAboveThreshold: 0,
    peakMarketCap: 0,
    peakTimestamp: null,
    currentMarketCap: token.marketCapUsd,
    dailyMarketCaps: [],
  };

  if (!token.primaryPairAddress) {
    result.reachedThreshold = token.marketCapUsd >= config.marketCapThreshold;
    result.currentlyAbove = result.reachedThreshold;
    result.peakMarketCap = token.marketCapUsd;
    return result;
  }

  const bars = await fetchDailyBars(
    client,
    token.primaryPairAddress,
    token.networkId
  );

  if (bars.length === 0) {
    result.reachedThreshold = token.marketCapUsd >= config.marketCapThreshold;
    result.currentlyAbove = result.reachedThreshold;
    result.peakMarketCap = token.marketCapUsd;
    return result;
  }

  const supplyMultiplier = getSupplyMultiplier(token);

  for (const bar of bars) {
    const highMcap = bar.high * supplyMultiplier;
    const closeMcap = bar.close * supplyMultiplier;

    result.dailyMarketCaps.push({
      timestamp: bar.timestamp,
      marketCap: closeMcap,
    });

    if (highMcap >= config.marketCapThreshold) {
      result.reachedThreshold = true;
      if (!result.firstCrossTimestamp) {
        result.firstCrossTimestamp = bar.timestamp;
      }
    }

    if (closeMcap >= config.marketCapThreshold) {
      result.daysAboveThreshold++;
    }

    if (highMcap > result.peakMarketCap) {
      result.peakMarketCap = highMcap;
      result.peakTimestamp = bar.timestamp;
    }
  }

  const lastBar = bars[bars.length - 1];
  const lastCloseMcap = lastBar.close * supplyMultiplier;
  result.currentlyAbove = lastCloseMcap >= config.marketCapThreshold;
  result.currentMarketCap = lastCloseMcap;

  return result;
}

/**
 * Batch-analyze trajectories for multiple tokens.
 * Reports progress and calls onProgress after each token.
 */
export async function analyzeAllTrajectories(
  client: GraphQLClient,
  tokens: TokenInfo[],
  config: CodexConfig,
  onProgress?: (trajectory: MarketCapTrajectory, index: number, total: number) => void
): Promise<MarketCapTrajectory[]> {
  const results: MarketCapTrajectory[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      console.log(`  [trajectory] (${i + 1}/${tokens.length}) Analyzing ${token.symbol}...`);
      const trajectory = await analyzeTrajectory(client, token, config);
      results.push(trajectory);
      console.log(
        `  [trajectory] ${token.symbol}: reached=${trajectory.reachedThreshold}, ` +
          `peak=${formatMcap(trajectory.peakMarketCap)}, days_above=${trajectory.daysAboveThreshold}`
      );
      onProgress?.(trajectory, i, tokens.length);
    } catch (err) {
      console.error(`  [trajectory] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}

function formatMcap(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
