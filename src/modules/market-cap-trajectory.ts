/**
 * Module 2: Market Cap Trajectory Analysis
 *
 * Two-pass approach using getTokenBars (no pair address needed):
 *
 * Pass 1 — Weekly pre-screen: Fetch 7D bars for each candidate.
 *   If weeklyHigh × supply never approached $10M, skip the token.
 *   This is 1 API call per candidate.
 *
 * Pass 2 — Hourly precision: For tokens that passed weekly screen,
 *   fetch 60-minute bars for full history. This gives exact hours
 *   above $10M (some tokens only stay there for a few hours).
 *   ~12 API calls per token (1500 bars per request, ~16,800 hours total).
 *
 * Uses getTokenBars which aggregates across all valid pairs for a token,
 * so we don't need to look up pair addresses.
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
  SOLANA_DATA_START,
} from "../utils/helpers.js";

interface BarsResponse {
  getTokenBars: {
    o: (number | null)[];
    h: (number | null)[];
    l: (number | null)[];
    c: (number | null)[];
    volume: (string | null)[] | null;
    t: number[];
    s: string;
  };
}

// Legacy getBars response for backward compatibility
interface LegacyBarsResponse {
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

/**
 * Fetch bars using getTokenBars (token-level, aggregated across pairs).
 * No pair address needed — just token address + network ID.
 */
async function fetchTokenBars(
  client: GraphQLClient,
  tokenAddress: string,
  networkId: number,
  resolution: string,
  from?: number,
  to?: number,
): Promise<OHLCVBar[]> {
  const symbol = `${tokenAddress}:${networkId}`;
  const fromTs = from ?? toUnixSeconds(SOLANA_DATA_START);
  const toTs = to ?? toUnixSeconds(new Date());

  try {
    const data = await rateLimitedQuery<BarsResponse>(client, QUERIES.GET_TOKEN_BARS, {
      symbol,
      from: fromTs,
      to: toTs,
      resolution,
      removeLeadingNullValues: true,
      currencyCode: "USD",
    });

    const bars = data.getTokenBars;
    if (bars.s !== "ok" || !bars.t?.length) {
      return [];
    }

    return bars.t.map((t, i) => ({
      timestamp: t,
      open: bars.o[i] ?? 0,
      high: bars.h[i] ?? 0,
      low: bars.l[i] ?? 0,
      close: bars.c[i] ?? 0,
      volume: bars.volume?.[i] ? parseFloat(bars.volume[i]!) : 0,
    }));
  } catch (err) {
    const msg = err && typeof err === "object" && "message" in err
      ? String((err as { message: string }).message).slice(0, 200)
      : "Unknown error";
    console.error(`  [bars] Error fetching bars for ${symbol}: ${msg}`);
    return [];
  }
}

/**
 * Fetch hourly history. Since max is 1500 bars per request and
 * we may need up to ~16,800 hours (March 2024 → Feb 2026), we paginate by time window.
 * If analysisWindowDays is set, only fetches the last N days.
 */
async function fetchFullHourlyBars(
  client: GraphQLClient,
  tokenAddress: string,
  networkId: number,
  analysisWindowDays?: number,
): Promise<OHLCVBar[]> {
  const allBars: OHLCVBar[] = [];
  const endTs = toUnixSeconds(new Date());
  const startTs = analysisWindowDays
    ? endTs - (analysisWindowDays * 86400)
    : toUnixSeconds(SOLANA_DATA_START);
  const HOURS_PER_BATCH = 1400; // slightly under 1500 limit for safety
  const BATCH_SECONDS = HOURS_PER_BATCH * 3600;

  let cursor = startTs;
  let batchNum = 0;

  while (cursor < endTs) {
    batchNum++;
    const batchEnd = Math.min(cursor + BATCH_SECONDS, endTs);
    const bars = await fetchTokenBars(
      client, tokenAddress, networkId, "60", cursor, batchEnd
    );

    if (bars.length > 0) {
      allBars.push(...bars);
    }

    cursor = batchEnd;

    if (batchNum % 4 === 0) {
      console.log(`    [hourly] ${tokenAddress.slice(0, 8)}... batch ${batchNum}: ${allBars.length} bars so far`);
    }
  }

  return allBars;
}

/**
 * Derive the effective supply multiplier from Codex's own market cap / price.
 * This is decimal-adjusted (unlike raw on-chain circulatingSupply/totalSupply).
 */
function getSupplyMultiplier(token: TokenInfo): number {
  if (token.priceUsd > 0 && token.marketCapUsd > 0) {
    return token.marketCapUsd / token.priceUsd;
  }
  return 0;
}

/**
 * Pass 1: Weekly pre-screen.
 * Returns true if the token's weekly high × supply ever reached $5M
 * (using $5M as buffer below $10M to avoid false negatives from
 * supply estimation errors).
 */
export async function weeklyPreScreen(
  client: GraphQLClient,
  token: TokenInfo,
  config: CodexConfig,
): Promise<{ passed: boolean; estimatedPeakMcap: number }> {
  const supplyMultiplier = getSupplyMultiplier(token);

  // If we can't compute supply, check if current mcap already qualifies
  if (supplyMultiplier <= 0) {
    return {
      passed: token.marketCapUsd >= config.marketCapThreshold,
      estimatedPeakMcap: token.marketCapUsd,
    };
  }

  const windowStart = config.analysisWindowDays
    ? toUnixSeconds(new Date()) - (config.analysisWindowDays * 86400)
    : undefined;
  const weeklyBars = await fetchTokenBars(
    client, token.address, token.networkId, "7D", windowStart
  );

  if (weeklyBars.length === 0) {
    // No bar data — use current mcap as only signal
    return {
      passed: token.marketCapUsd >= config.marketCapThreshold,
      estimatedPeakMcap: token.marketCapUsd,
    };
  }

  // Find peak weekly high × supply
  let peakMcap = 0;
  for (const bar of weeklyBars) {
    const highMcap = bar.high * supplyMultiplier;
    if (highMcap > peakMcap) peakMcap = highMcap;
  }

  // Also consider current market cap
  peakMcap = Math.max(peakMcap, token.marketCapUsd);

  // Use $5M threshold (half of $10M) to avoid false negatives
  // from supply estimation errors
  const preScreenThreshold = config.marketCapThreshold * 0.5;

  return {
    passed: peakMcap >= preScreenThreshold,
    estimatedPeakMcap: peakMcap,
  };
}

/**
 * Pass 2: Hourly precision analysis.
 * Fetches full hourly bar history and computes precise trajectory.
 */
export async function analyzeTrajectoryHourly(
  client: GraphQLClient,
  token: TokenInfo,
  config: CodexConfig,
): Promise<MarketCapTrajectory> {
  const result: MarketCapTrajectory = {
    tokenAddress: token.address,
    symbol: token.symbol,
    reachedThreshold: false,
    firstCrossTimestamp: null,
    currentlyAbove: false,
    daysAboveThreshold: 0,
    hoursAboveThreshold: 0,
    peakMarketCap: 0,
    peakTimestamp: null,
    currentMarketCap: token.marketCapUsd,
    dailyMarketCaps: [],
  };

  const supplyMultiplier = getSupplyMultiplier(token);

  if (supplyMultiplier <= 0) {
    result.reachedThreshold = token.marketCapUsd >= config.marketCapThreshold;
    result.currentlyAbove = result.reachedThreshold;
    result.peakMarketCap = token.marketCapUsd;
    return result;
  }

  // Fetch hourly history (respects analysisWindowDays)
  const hourlyBars = await fetchFullHourlyBars(
    client, token.address, token.networkId, config.analysisWindowDays
  );

  if (hourlyBars.length === 0) {
    result.reachedThreshold = token.marketCapUsd >= config.marketCapThreshold;
    result.currentlyAbove = result.reachedThreshold;
    result.peakMarketCap = token.marketCapUsd;
    return result;
  }

  // Track hours above threshold
  let hoursAbove = 0;

  // Track daily aggregates for the chart
  const dailyMap = new Map<string, { timestamp: number; maxMcap: number; closeMcap: number }>();

  for (const bar of hourlyBars) {
    const highMcap = bar.high * supplyMultiplier;
    const closeMcap = bar.close * supplyMultiplier;

    // Track hourly threshold crossing
    if (highMcap >= config.marketCapThreshold) {
      result.reachedThreshold = true;
      hoursAbove++;
      if (!result.firstCrossTimestamp) {
        result.firstCrossTimestamp = bar.timestamp;
      }
    }

    // Track peak
    if (highMcap > result.peakMarketCap) {
      result.peakMarketCap = highMcap;
      result.peakTimestamp = bar.timestamp;
    }

    // Aggregate into daily buckets for chart
    const dayKey = new Date(bar.timestamp * 1000).toISOString().slice(0, 10);
    const existing = dailyMap.get(dayKey);
    if (!existing || closeMcap > 0) {
      dailyMap.set(dayKey, {
        timestamp: existing?.timestamp ?? bar.timestamp,
        maxMcap: Math.max(existing?.maxMcap ?? 0, highMcap),
        closeMcap, // last hour's close becomes the day's close
      });
    }
  }

  // Convert daily map to array
  result.dailyMarketCaps = Array.from(dailyMap.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((d) => ({ timestamp: d.timestamp, marketCap: d.closeMcap }));

  // Count days above threshold (using daily max)
  result.daysAboveThreshold = Array.from(dailyMap.values())
    .filter((d) => d.maxMcap >= config.marketCapThreshold).length;

  result.hoursAboveThreshold = hoursAbove;

  // Current status from last bar
  if (hourlyBars.length > 0) {
    const lastBar = hourlyBars[hourlyBars.length - 1];
    const lastCloseMcap = lastBar.close * supplyMultiplier;
    result.currentlyAbove = lastCloseMcap >= config.marketCapThreshold;
    result.currentMarketCap = lastCloseMcap;
  }

  return result;
}

/**
 * Full two-pass analysis for all candidate tokens.
 *
 * Pass 1: Weekly pre-screen (1 call per token, fast)
 * Pass 2: Hourly analysis (only for tokens that passed, ~12 calls per token)
 */
export async function analyzeAllTrajectories(
  client: GraphQLClient,
  tokens: TokenInfo[],
  config: CodexConfig,
  onProgress?: (trajectory: MarketCapTrajectory, index: number, total: number) => void
): Promise<MarketCapTrajectory[]> {
  const results: MarketCapTrajectory[] = [];

  // ── Pass 1: Weekly pre-screen ──
  console.log(`\n  [trajectory] Pass 1: Weekly pre-screen for ${tokens.length} candidates...`);
  const candidates: Array<{ token: TokenInfo; estimatedPeakMcap: number }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      if ((i + 1) % 100 === 0 || i === 0) {
        console.log(`  [weekly] (${i + 1}/${tokens.length}) Screening...`);
      }
      const result = await weeklyPreScreen(client, token, config);
      if (result.passed) {
        candidates.push({ token, estimatedPeakMcap: result.estimatedPeakMcap });
      }
    } catch (err) {
      console.error(`  [weekly] Error screening ${token.symbol}:`, err);
    }
  }

  console.log(`  [trajectory] Pass 1 complete: ${candidates.length} of ${tokens.length} passed weekly pre-screen`);

  // Sort candidates by estimated peak market cap (most promising first)
  candidates.sort((a, b) => b.estimatedPeakMcap - a.estimatedPeakMcap);

  // ── Pass 2: Hourly precision ──
  console.log(`\n  [trajectory] Pass 2: Hourly analysis for ${candidates.length} candidates...`);

  for (let i = 0; i < candidates.length; i++) {
    const { token } = candidates[i];
    try {
      console.log(
        `  [hourly] (${i + 1}/${candidates.length}) Analyzing ${token.symbol} ` +
        `(est. peak ${formatMcap(candidates[i].estimatedPeakMcap)})...`
      );
      const trajectory = await analyzeTrajectoryHourly(client, token, config);
      results.push(trajectory);
      console.log(
        `  [hourly] ${token.symbol}: reached=${trajectory.reachedThreshold}, ` +
        `peak=${formatMcap(trajectory.peakMarketCap)}, ` +
        `hours_above=${trajectory.hoursAboveThreshold}, ` +
        `days_above=${trajectory.daysAboveThreshold}`
      );
      onProgress?.(trajectory, i, candidates.length);
    } catch (err) {
      console.error(`  [hourly] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}

// Legacy export for backward compatibility
export async function analyzeTrajectory(
  client: GraphQLClient,
  token: TokenInfo,
  config: CodexConfig
): Promise<MarketCapTrajectory> {
  return analyzeTrajectoryHourly(client, token, config);
}

function formatMcap(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}
