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
import { paginateAll, toUnixSeconds, SOLANA_DATA_START, parallelMap } from "../utils/helpers.js";

const DISCOVERY_CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "15", 10);

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

interface TimeWindow {
  gte: number;
  lte: number;
  label: string;
}

/**
 * Generate monthly time windows from Solana data start to now.
 */
function generateMonthlyWindows(): TimeWindow[] {
  const windows: TimeWindow[] = [];
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
 * Split a time window into weekly sub-windows.
 */
function splitIntoWeeks(window: TimeWindow): TimeWindow[] {
  const weeks: TimeWindow[] = [];
  const WEEK_SECS = 7 * 24 * 60 * 60;
  let start = window.gte;

  while (start < window.lte) {
    const end = Math.min(start + WEEK_SECS - 1, window.lte);
    const startDate = new Date(start * 1000);
    const label = `${window.label}/W${startDate.getDate().toString().padStart(2, "0")}`;
    weeks.push({ gte: start, lte: end, label });
    start = end + 1;
  }

  return weeks;
}

/**
 * Split a time window into daily sub-windows.
 */
function splitIntoDays(window: TimeWindow): TimeWindow[] {
  const days: TimeWindow[] = [];
  const DAY_SECS = 24 * 60 * 60;
  let start = window.gte;

  while (start < window.lte) {
    const end = Math.min(start + DAY_SECS - 1, window.lte);
    const startDate = new Date(start * 1000);
    const label = `${window.label}/${startDate.toISOString().slice(5, 10)}`;
    days.push({ gte: start, lte: end, label });
    start = end + 1;
  }

  return days;
}

/**
 * Run a single sweep, fetching all matching tokens via pagination.
 * If knownCount is provided, skips the probe call to save an API call.
 */
async function runSweep(
  client: GraphQLClient,
  sweep: SweepConfig,
  seen: Set<string>,
  allTokens: TokenInfo[],
  onProgress?: (fetched: number, total: number) => void,
  grandTotal?: number,
  knownCount?: number,
): Promise<{ fetched: number; newCount: number; hitCap: boolean }> {
  const PAGE_SIZE = 200;

  let sweepTotal: number;
  if (knownCount !== undefined) {
    sweepTotal = knownCount;
  } else {
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
    sweepTotal = probe.filterTokens.count;
  }

  if (sweepTotal === 0) {
    return { fetched: 0, newCount: 0, hitCap: false };
  }

  const { items: results, hitCap } = await paginateAll<FilterTokenResult>(
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

  return { fetched: results.length, newCount, hitCap };
}

/**
 * Process a single time window: probe, decide to split or paginate.
 * Returns { fetched, newCount } for the window (including any sub-splits).
 */
async function processWindow(
  client: GraphQLClient,
  baseFilters: Record<string, unknown>,
  rankings: SweepConfig["rankings"],
  label: string,
  win: TimeWindow,
  seen: Set<string>,
  allTokens: TokenInfo[],
  onProgress?: (fetched: number, total: number) => void,
  indent = "    ",
): Promise<{ fetched: number; newCount: number }> {
  const filters = { ...baseFilters, createdAt: { gte: win.gte, lte: win.lte } };
  const spanDays = (win.lte - win.gte) / 86400;

  // Probe first to check count (1 API call)
  const probe = await rateLimitedQuery<FilterTokensResponse>(
    client,
    QUERIES.FILTER_TOKENS,
    { filters, rankings: [rankings], limit: 1, offset: 0 },
  );
  const count = probe.filterTokens.count;

  if (count === 0) return { fetched: 0, newCount: 0 };

  // If count is near the 10K cap and we can still split, skip pagination
  // and go straight to sub-windows to avoid wasting API calls
  if (count >= 9800 && spanDays > 1) {
    const subWindows = spanDays > 7 ? splitIntoWeeks(win) : splitIntoDays(win);
    const level = spanDays > 7 ? "weekly" : "daily";
    console.log(`${indent}[${win.label}] ~${count} tokens, splitting into ${subWindows.length} ${level} windows...`);

    return sweepWindows(
      client, baseFilters, rankings, label, subWindows,
      seen, allTokens, onProgress, indent + "  ",
    );
  }

  // Count is manageable — paginate normally (pass count to skip double-probe)
  const sweep: SweepConfig = { label: `${label} [${win.label}]`, filters, rankings };
  const result = await runSweep(client, sweep, seen, allTokens, onProgress, undefined, count);

  if (result.fetched > 0) {
    console.log(`${indent}[${win.label}] ${result.fetched} fetched, ${result.newCount} new`);
  }

  // If pagination hit the 10K cap and we can still split, split and re-sweep
  // to catch tokens beyond the cap (dedup via `seen` avoids double-counting)
  if (result.hitCap && spanDays > 1) {
    const subWindows = spanDays > 7 ? splitIntoWeeks(win) : splitIntoDays(win);
    const level = spanDays > 7 ? "weekly" : "daily";
    console.log(`${indent}[${win.label}] ⚠ Hit 10K cap (${result.fetched} items), splitting into ${subWindows.length} ${level} windows...`);

    const sub = await sweepWindows(
      client, baseFilters, rankings, label, subWindows,
      seen, allTokens, onProgress, indent + "  ",
    );
    return {
      fetched: result.fetched + sub.fetched,
      newCount: result.newCount + sub.newCount,
    };
  }

  // At daily granularity, just accept the cap
  if (result.hitCap && spanDays <= 1) {
    console.log(`${indent}[${win.label}] ⚠ Daily window hit 10K cap, accepting (${result.fetched} items)`);
  }

  return { fetched: result.fetched, newCount: result.newCount };
}

/**
 * Sweep a list of time windows in parallel, recursively splitting windows
 * that hit the 10K offset cap. Splits month→week→day to ensure nothing is lost.
 */
async function sweepWindows(
  client: GraphQLClient,
  baseFilters: Record<string, unknown>,
  rankings: SweepConfig["rankings"],
  label: string,
  windows: TimeWindow[],
  seen: Set<string>,
  allTokens: TokenInfo[],
  onProgress?: (fetched: number, total: number) => void,
  indent = "    ",
): Promise<{ fetched: number; newCount: number }> {
  const results = await parallelMap(
    windows,
    (win) => processWindow(client, baseFilters, rankings, label, win, seen, allTokens, onProgress, indent),
    DISCOVERY_CONCURRENCY,
  );

  let totalFetched = 0;
  let totalNew = 0;
  for (const r of results) {
    totalFetched += r.fetched;
    totalNew += r.newCount;
  }

  return { fetched: totalFetched, newCount: totalNew };
}

/**
 * Discover ALL Solana tokens that could have historically reached $10M.
 *
 * Uses monthly time-window pagination for broad sweeps to work around
 * potential API offset limits. Each month is queried separately, ensuring
 * we capture tokens even if a single query would exceed the offset cap.
 * Windows that hit the 10K cap are recursively split: month → week → day.
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
  const globalSweeps: Array<{ label: string; filters: Record<string, unknown>; rankings: SweepConfig["rankings"] }> = [
    {
      label: "liquidity >= $100K",
      filters: { network: [config.solanaNetworkId], liquidity: { gte: 100_000 } },
      rankings: { attribute: "liquidity", direction: "DESC" },
    },
    {
      label: "marketCap >= $1M",
      filters: { network: [config.solanaNetworkId], marketCap: { gte: 1_000_000 } },
      rankings: { attribute: "marketCap", direction: "DESC" },
    },
    {
      label: "holders >= 1000",
      filters: { network: [config.solanaNetworkId], holders: { gte: 1_000 } },
      rankings: { attribute: "holders", direction: "DESC" },
    },
  ];

  // Run all global sweeps in parallel
  await parallelMap(globalSweeps, async (gs) => {
    console.log(`  [discover] Global sweep: ${gs.label}`);
    const { fetched, newCount, hitCap } = await runSweep(
      client, { label: gs.label, filters: gs.filters, rankings: gs.rankings },
      seen, allTokens, onProgress,
    );
    console.log(`  [discover]   ${gs.label}: ${fetched} fetched, ${newCount} new (${allTokens.length} total unique)${hitCap ? " ⚠ HIT 10K CAP" : ""}`);

    if (hitCap) {
      console.log(`  [discover]   Falling back to monthly windows for "${gs.label}"...`);
      const sub = await sweepWindows(client, gs.filters, gs.rankings, gs.label, months, seen, allTokens, onProgress);
      console.log(`  [discover]   ${gs.label} windowed: ${sub.fetched} fetched, ${sub.newCount} new (${allTokens.length} total unique)`);
    }
  }, globalSweeps.length); // All 3 global sweeps at once

  // ── Tier 2: Monthly windowed sweeps (catches faded/dead tokens) ──
  // Raised thresholds: any token that hit $10M mcap will still have
  // 1000+ holders, $100K+ liquidity, or $1M+ mcap even after crashing.
  const monthlySweepConfigs = [
    { label: "holders >= 1000", filters: { network: [config.solanaNetworkId], holders: { gte: 1_000 } }, rankings: { attribute: "holders", direction: "DESC" } },
    { label: "liquidity >= $100K", filters: { network: [config.solanaNetworkId], liquidity: { gte: 100_000 } }, rankings: { attribute: "liquidity", direction: "DESC" } },
    { label: "marketCap >= $1M", filters: { network: [config.solanaNetworkId], marketCap: { gte: 1_000_000 } }, rankings: { attribute: "marketCap", direction: "DESC" } },
  ];

  // Run all monthly sweep configs in parallel, each scanning all months concurrently
  await parallelMap(monthlySweepConfigs, async (cfg) => {
    console.log(`  [discover] Monthly sweep: ${cfg.label} (${months.length} months)`);
    const sub = await sweepWindows(client, cfg.filters, cfg.rankings, cfg.label, months, seen, allTokens, onProgress);
    console.log(`  [discover]   ${cfg.label} total: ${sub.fetched} fetched, ${sub.newCount} new (${allTokens.length} total unique)`);
  }, monthlySweepConfigs.length); // All 3 monthly sweeps at once

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
