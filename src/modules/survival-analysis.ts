/**
 * Module 4: Token Survival Analysis
 *
 * Determines whether tokens "survive" at 30, 90, and 365 day checkpoints.
 * Survival = liquidity pool > $100,000 at the checkpoint date.
 *
 * Strategy:
 * - For each token, find its primary pair.
 * - Use getDetailedPairStats to get liquidity data at specific time windows.
 * - Check liquidity at 30/90/365 days after the token first hit $10M.
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
  barSymbol,
  SOLANA_DATA_START,
} from "../utils/helpers.js";

interface PairListResponse {
  listPairsWithMetadataForToken: {
    results: Array<{
      pair: { address: string; token0: string; token1: string };
      liquidity: number;
      volume24: number;
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

/**
 * Get current total liquidity across all pairs for a token.
 */
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

  // Primary pair = highest liquidity
  const sorted = [...pairs].sort(
    (a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)
  );

  return {
    totalLiquidity,
    primaryPair: sorted[0].pair.address,
  };
}

/**
 * Get the liquidity at a specific date by looking at detailed pair stats.
 * We look at stats around the target date.
 */
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
          // Look at a window around the target date
          current: targetTimestamp,
          previous: targetTimestamp - SECONDS_PER_DAY,
        },
      }
    );

    const stats = data.getDetailedPairStats?.stats_day1;
    if (stats && stats.length > 0) {
      // Return the liquidity from the closest data point
      return stats[0].statsUsd.liquidity.currentValue;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Analyze survival for a single token.
 */
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

  // If no trajectory data or no pair, return with current data only
  if (!trajectory.firstCrossTimestamp || !primaryPair) {
    return result;
  }

  const firstCrossTs = trajectory.firstCrossTimestamp;
  const now = toUnixSeconds(new Date());

  // Check each checkpoint
  const checkpoints = [
    { key: "days30" as const, days: 30 },
    { key: "days90" as const, days: 90 },
    { key: "days365" as const, days: 365 },
  ];

  for (const cp of checkpoints) {
    const checkpointTs = firstCrossTs + cp.days * SECONDS_PER_DAY;

    // Only check if enough time has elapsed
    if (checkpointTs > now) {
      // Not enough time has passed yet
      continue;
    }

    // Also check if the date is within Codex's data range
    if (checkpointTs < toUnixSeconds(SOLANA_DATA_START)) {
      continue;
    }

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

  // Get liquidity at discovery
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
 * Batch survival analysis for multiple tokens.
 */
export async function analyzeAllSurvivals(
  client: GraphQLClient,
  tokens: TokenInfo[],
  trajectories: MarketCapTrajectory[],
  config: CodexConfig
): Promise<SurvivalAnalysis[]> {
  const trajectoryMap = new Map(
    trajectories.map((t) => [t.tokenAddress, t])
  );
  const results: SurvivalAnalysis[] = [];

  for (const token of tokens) {
    const trajectory = trajectoryMap.get(token.address);
    if (!trajectory) continue;

    try {
      const survival = await analyzeSurvival(client, token, trajectory, config);
      results.push(survival);

      const alive30 = survival.checkpoints.days30?.alive ?? "N/A";
      const alive90 = survival.checkpoints.days90?.alive ?? "N/A";
      const alive365 = survival.checkpoints.days365?.alive ?? "N/A";
      console.log(
        `  [survival] ${token.symbol}: current_liq=$${(survival.currentLiquidity / 1e3).toFixed(0)}K ` +
          `30d=${alive30} 90d=${alive90} 365d=${alive365}`
      );
    } catch (err) {
      console.error(`  [survival] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}
