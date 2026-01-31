/**
 * Module 4: Token Survival Analysis
 *
 * Determines whether tokens "survive" at 30, 90, and 365 day checkpoints.
 * Survival = liquidity pool > $100,000 at the checkpoint date.
 */

import type { GraphQLClient } from "graphql-request";
import type {
  CodexConfig,
  SurvivalAnalysis,
  MarketCapTrajectory,
  TokenInfo,
} from "../types/index.js";
import { QUERIES, rateLimitedQuery } from "../client/codex.js";
import {
  toUnixSeconds,
  fromUnixSeconds,
  SOLANA_DATA_START,
} from "../utils/helpers.js";

interface PairListResponse {
  listPairsWithMetadataForToken: {
    results: Array<{
      pair: { address: string; token0: string; token1: string };
      liquidity: number;
    }>;
  };
}

interface DetailedPairStatsResponse {
  getDetailedPairStats: {
    stats_day1: Array<{
      statsUsd: {
        volume: { currentValue: number };
        liquidity: { currentValue: number };
        buyers: { currentValue: number };
        sellers: { currentValue: number };
      };
      timestamp: number;
    }>;
  };
}

const SECONDS_PER_DAY = 86400;

async function getCurrentLiquidity(
  client: GraphQLClient,
  tokenAddress: string,
  networkId: number
): Promise<{ totalLiquidity: number; primaryPair: string | null }> {
  const data = await rateLimitedQuery<PairListResponse>(
    client,
    QUERIES.LIST_PAIRS_FOR_TOKEN,
    { tokenAddress, networkId }
  );

  const pairs = data.listPairsWithMetadataForToken?.results ?? [];
  if (pairs.length === 0) {
    return { totalLiquidity: 0, primaryPair: null };
  }

  const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity ?? 0), 0);
  const sorted = [...pairs].sort(
    (a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)
  );

  return {
    totalLiquidity,
    primaryPair: sorted[0].pair.address,
  };
}

async function getLiquidityAtDate(
  client: GraphQLClient,
  pairAddress: string,
  networkId: number,
  targetTimestamp: number
): Promise<number | null> {
  try {
    const data = await rateLimitedQuery<DetailedPairStatsResponse>(
      client,
      QUERIES.GET_DETAILED_PAIR_STATS,
      {
        pairAddress,
        networkId,
        tokenOfInterest: "token0",
        statsType: "UNFILTERED",
        timestamp: {
          current: targetTimestamp,
          previous: targetTimestamp - SECONDS_PER_DAY,
        },
      }
    );

    const stats = data.getDetailedPairStats?.stats_day1;
    if (stats && stats.length > 0) {
      return stats[0].statsUsd.liquidity.currentValue;
    }
    return null;
  } catch {
    return null;
  }
}

export async function analyzeSurvival(
  client: GraphQLClient,
  token: TokenInfo,
  trajectory: MarketCapTrajectory,
  config: CodexConfig
): Promise<SurvivalAnalysis> {
  const { totalLiquidity, primaryPair } = await getCurrentLiquidity(
    client,
    token.address,
    token.networkId
  );

  const result: SurvivalAnalysis = {
    tokenAddress: token.address,
    symbol: token.symbol,
    liquidityAtDiscovery: 0,
    currentLiquidity: totalLiquidity,
    checkpoints: {
      days30: null,
      days90: null,
      days365: null,
    },
    currentlyAlive: totalLiquidity >= config.liquiditySurvivalThreshold,
  };

  if (!trajectory.firstCrossTimestamp || !primaryPair) {
    return result;
  }

  const firstCrossTs = trajectory.firstCrossTimestamp;
  const now = toUnixSeconds(new Date());

  const checkpoints = [
    { key: "days30" as const, days: 30 },
    { key: "days90" as const, days: 90 },
    { key: "days365" as const, days: 365 },
  ];

  for (const cp of checkpoints) {
    const checkpointTs = firstCrossTs + cp.days * SECONDS_PER_DAY;

    if (checkpointTs > now) continue;
    if (checkpointTs < toUnixSeconds(SOLANA_DATA_START)) continue;

    const liquidity = await getLiquidityAtDate(
      client,
      primaryPair,
      token.networkId,
      checkpointTs
    );

    if (liquidity !== null) {
      result.checkpoints[cp.key] = {
        liquidity,
        alive: liquidity >= config.liquiditySurvivalThreshold,
        date: fromUnixSeconds(checkpointTs).toISOString().split("T")[0],
      };
    }
  }

  const discoveryLiquidity = await getLiquidityAtDate(
    client,
    primaryPair,
    token.networkId,
    firstCrossTs
  );
  result.liquidityAtDiscovery = discoveryLiquidity ?? 0;

  return result;
}

/**
 * Batch survival analysis for multiple tokens with progress tracking.
 */
export async function analyzeAllSurvivals(
  client: GraphQLClient,
  tokens: TokenInfo[],
  trajectories: MarketCapTrajectory[],
  config: CodexConfig,
  onProgress?: (survival: SurvivalAnalysis, index: number, total: number) => void
): Promise<SurvivalAnalysis[]> {
  const trajectoryMap = new Map(
    trajectories.map((t) => [t.tokenAddress, t])
  );
  const results: SurvivalAnalysis[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const trajectory = trajectoryMap.get(token.address);
    if (!trajectory) continue;

    try {
      console.log(`  [survival] (${i + 1}/${tokens.length}) Analyzing ${token.symbol}...`);
      const survival = await analyzeSurvival(client, token, trajectory, config);
      results.push(survival);

      const alive30 = survival.checkpoints.days30?.alive ?? "N/A";
      const alive90 = survival.checkpoints.days90?.alive ?? "N/A";
      const alive365 = survival.checkpoints.days365?.alive ?? "N/A";
      console.log(
        `  [survival] ${token.symbol}: current_liq=$${(survival.currentLiquidity / 1e3).toFixed(0)}K ` +
          `30d=${alive30} 90d=${alive90} 365d=${alive365}`
      );
      onProgress?.(survival, i, tokens.length);
    } catch (err) {
      console.error(`  [survival] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}
