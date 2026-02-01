/**
 * Module 4: Token Survival Analysis
 *
 * Determines whether tokens "survive" at 30, 90, and 365 day checkpoints.
 * Survival = liquidity pool > $100,000 at the checkpoint date.
 *
 * Uses getDetailedPairStats with timestamp (Int) to look up historical
 * liquidity at specific dates, plus current liquidity from pair listing.
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
      liquidity: string; // GraphQL String! — must parseFloat
    }>;
  };
}

interface DetailedPairStatsResponse {
  getDetailedPairStats: {
    stats_day1?: {
      statsUsd: {
        liquidity: { currentValue: string | null; buckets: string[] };
      };
      start: number;
      end: number;
    };
    stats_day30?: {
      statsUsd: {
        liquidity: { currentValue: string | null; buckets: string[] };
      };
      start: number;
      end: number;
    };
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

  // liquidity is String! in the GraphQL schema — must parseFloat
  const parsedPairs = pairs.map((p) => ({
    ...p,
    liqUsd: parseFloat(p.liquidity as string) || 0,
  }));
  const totalLiquidity = parsedPairs.reduce((sum, p) => sum + p.liqUsd, 0);
  const sorted = [...parsedPairs].sort((a, b) => b.liqUsd - a.liqUsd);

  return {
    totalLiquidity,
    primaryPair: sorted[0].pair.address,
  };
}

/**
 * Get liquidity at a specific historical timestamp.
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
        timestamp: targetTimestamp,
        bucketCount: 1,
      }
    );

    // Try day1 stats first, then day30
    const day1Liq = data.getDetailedPairStats?.stats_day1?.statsUsd?.liquidity;
    if (day1Liq?.currentValue) {
      return parseFloat(day1Liq.currentValue);
    }

    const day30Liq = data.getDetailedPairStats?.stats_day30?.statsUsd?.liquidity;
    if (day30Liq?.currentValue) {
      return parseFloat(day30Liq.currentValue);
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

  // Get liquidity at discovery
  const discoveryLiquidity = await getLiquidityAtDate(
    client,
    primaryPair,
    token.networkId,
    firstCrossTs
  );
  result.liquidityAtDiscovery = discoveryLiquidity ?? 0;

  // Only compute checkpoints that fall within the analysis window
  const windowDays = config.analysisWindowDays;
  const allCheckpoints = [
    { key: "days30" as const, days: 30 },
    { key: "days90" as const, days: 90 },
    { key: "days365" as const, days: 365 },
  ];
  const checkpoints = windowDays
    ? allCheckpoints.filter((cp) => cp.days <= windowDays)
    : allCheckpoints;

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

  return result;
}

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
      const liqStr = survival.currentLiquidity >= 1e6
        ? `$${(survival.currentLiquidity / 1e6).toFixed(1)}M`
        : `$${(survival.currentLiquidity / 1e3).toFixed(0)}K`;
      console.log(
        `  [survival] ${token.symbol}: liq=${liqStr} 30d=${alive30} 90d=${alive90} 365d=${alive365}`
      );
      onProgress?.(survival, i, tokens.length);
    } catch (err) {
      console.error(`  [survival] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}
