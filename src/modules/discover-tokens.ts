/**
 * Module 1: Token Discovery
 *
 * Finds all Solana tokens that could have historically reached $10M market cap.
 *
 * Strategy: Multiple overlapping sweeps with monthly time-window pagination.
 * The Codex filterTokens API may cap results per query (offset limit), so we
 * break each sweep into monthly createdAt windows to ensure full coverage.
 *
 * Sweeps:
 * 1. liquidity >= $10K (no date filter — catches established tokens)
 * 2. marketCap >= $50K (no date filter)
 * 3. holders >= 500 (no date filter)
 * 4. holders >= 50 per month (catches faded tokens with bagholders)
 * 5. liquidity >= $1 per month (catches tokens with any remaining pool)
 * 6. marketCap >= $100 per month (catches tokens with any remaining value)
 *
 * All results are unioned and deduplicated by address.
 * Phase 2 (trajectory analysis) validates which tokens actually crossed
 * $10M using historical price bars.
 *
 * Limitation: Codex only has Solana data from March 20, 2024 onward.
 */

import type { GraphQLClient } from "graphql-request";
import type { CodexConfig, TokenInfo } from "../types/index.js";
import { QUERIES, rateLimitedQuery } from "../client/codex.js";
import { paginateAll, toUnixSeconds, SOLANA_DATA_START } from "../utils/helpers.js";

interface FilterTokenResult {
  token: {
    address: string;
    networkId: number;
    name: string;
    symbol: string;
    totalSupply: string | null;
    circulatingSupply: string | null;
  };
  priceUSD: number;
  marketCap: number;
  liquidity: number;
  volume24: number;
  txnCount24: number;
  holders: number;
  pair: { address: string } | null;
}

interface FilterTokensResponse {
  filterTokens: {
    results: FilterTokenResult[];
    count: number;
  };
}

interface SweepConfig {
  label: string;
  filters: Record<string, unknown>;
  rankings: { attribute: string; direction: string };
}

/**
 * Generate monthly time windows from Solana data start to now.
 * Returns array of { gte, lte } unix timestamps for each month.
 */
function generateMonthlyWindows(): Array<{ gte: number; lte: number; label: string }> {
  const windows: Array<{ gte: number; lte: number; label: string }> = [];
  const start = new Date(SOLANA_DATA_START);
  const now = new Date();

  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cursor <= now) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
    const label = `${monthStart.toISOString().slice(0, 7)}`;

    windows.push({
      gte: toUnixSeconds(monthStart),
      lte: toUnixSeconds(monthEnd > now ? now : monthEnd),
      label,
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return windows;
}

/**
 * Run a single sweep, fetching all matching tokens via pagination.
 */
async function runSweep(
  client: GraphQLClient,
  sweep: SweepConfig,
  seen: Set<string>,
  allTokens: TokenInfo[],
  onProgress?: (fetched: number, total: number) => void,
  grandTotal?: number,
): Promise<{ fetched: number; newCount: number }> {
  const PAGE_SIZE = 200;

  const probe = await rateLimitedQuery<FilterTokensResponse>(
    client,
    QUERIES.FILTER_TOKENS,
    {
      filters: sweep.filters,
      rankings: [sweep.rankings],
      limit: 1,
      offset: 0,
    }
  );
  const sweepTotal = probe.filterTokens.count;

  if (sweepTotal === 0) {
    return { fetched: 0, newCount: 0 };
  }

  const results = await paginateAll<FilterTokenResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokensResponse>(
        client,
        QUERIES.FILTER_TOKENS,
        {
          filters: sweep.filters,
          rankings: [sweep.rankings],
          limit: PAGE_SIZE,
          offset,
        }
      );
      onProgress?.(allTokens.length + Math.min(offset + PAGE_SIZE, sweepTotal), grandTotal ?? sweepTotal);
      return {
        results: data.filterTokens.results,
        count: data.filterTokens.count,
      };
    },
    PAGE_SIZE,
    500 // up to 100K tokens per sweep/window
  );

  let newCount = 0;
  for (const r of results) {
    if (!seen.has(r.token.address)) {
      seen.add(r.token.address);
      allTokens.push(mapToTokenInfo(r));
      newCount++;
    }
  }

  return { fetched: results.length, newCount };
}

/**
 * Discover ALL Solana tokens that could have historically reached $10M.
 *
 * Uses monthly time-window pagination for broad sweeps to work around
 * potential API offset limits. Each month is queried separately, ensuring
 * we capture tokens even if a single query would exceed the offset cap.
 */
export async function discoverAllCandidates(
  client: GraphQLClient,
  config: CodexConfig,
  onProgress?: (fetched: number, total: number) => void,
): Promise<TokenInfo[]> {
  const seen = new Set<string>();
  const allTokens: TokenInfo[] = [];
  const months = generateMonthlyWindows();

  console.log(`  [discover] Will scan ${months.length} monthly windows (${months[0]?.label} → ${months[months.length - 1]?.label})`);

  // ── Tier 1: Global sweeps (no date filter, catches established tokens) ──
  const globalSweeps: SweepConfig[] = [
    {
      label: "liquidity >= $10K",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 10_000 },
      },
      rankings: { attribute: "liquidity", direction: "DESC" },
    },
    {
      label: "marketCap >= $50K",
      filters: {
        network: [config.solanaNetworkId],
        marketCap: { gte: 50_000 },
      },
      rankings: { attribute: "marketCap", direction: "DESC" },
    },
    {
      label: "holders >= 500",
      filters: {
        network: [config.solanaNetworkId],
        holders: { gte: 500 },
      },
      rankings: { attribute: "holders", direction: "DESC" },
    },
  ];

  for (const sweep of globalSweeps) {
    console.log(`  [discover] Global sweep: ${sweep.label}`);
    const { fetched, newCount } = await runSweep(client, sweep, seen, allTokens, onProgress);
    console.log(`  [discover]   ${fetched} fetched, ${newCount} new (${allTokens.length} total unique)`);
  }

  // ── Tier 2: Monthly windowed sweeps (catches faded/dead tokens) ──
  // These use very low thresholds per monthly window to bypass offset limits.
  // A token that hit $10M would almost always retain at least 50 holders
  // or some residual liquidity/mcap.

  const monthlySweepConfigs = [
    {
      label: "holders >= 50",
      filterKey: "holders",
      filterValue: { gte: 50 },
      rankAttr: "holders",
    },
    {
      label: "liquidity >= $1",
      filterKey: "liquidity",
      filterValue: { gte: 1 },
      rankAttr: "liquidity",
    },
    {
      label: "marketCap >= $100",
      filterKey: "marketCap",
      filterValue: { gte: 100 },
      rankAttr: "marketCap",
    },
  ];

  for (const sweepCfg of monthlySweepConfigs) {
    console.log(`  [discover] Monthly sweep: ${sweepCfg.label} (${months.length} months)`);
    let totalFetched = 0;
    let totalNew = 0;

    for (const month of months) {
      const sweep: SweepConfig = {
        label: `${sweepCfg.label} [${month.label}]`,
        filters: {
          network: [config.solanaNetworkId],
          [sweepCfg.filterKey]: sweepCfg.filterValue,
          createdAt: { gte: month.gte, lte: month.lte },
        },
        rankings: { attribute: sweepCfg.rankAttr, direction: "DESC" },
      };

      const { fetched, newCount } = await runSweep(client, sweep, seen, allTokens, onProgress);
      totalFetched += fetched;
      totalNew += newCount;

      if (fetched > 0) {
        console.log(`    [${month.label}] ${fetched} fetched, ${newCount} new`);
      }
    }

    console.log(`  [discover]   Monthly total: ${totalFetched} fetched, ${totalNew} new (${allTokens.length} total unique)`);
  }

  console.log(`  [discover] Discovery complete: ${allTokens.length} unique candidate tokens`);
  return allTokens;
}

function mapToTokenInfo(r: FilterTokenResult): TokenInfo {
  return {
    address: r.token.address,
    networkId: r.token.networkId,
    name: r.token.name,
    symbol: r.token.symbol,
    totalSupply: r.token.totalSupply,
    circulatingSupply: r.token.circulatingSupply,
    priceUsd: r.priceUSD,
    marketCapUsd: r.marketCap,
    firstHit10MTimestamp: null,
    primaryPairAddress: r.pair?.address ?? null,
  };
}

// Keep legacy exports for backward compatibility during transition
export const discoverCurrentTokensAboveThreshold = discoverAllCandidates;
export const discoverHistoricalCandidates = async () => [] as TokenInfo[];
