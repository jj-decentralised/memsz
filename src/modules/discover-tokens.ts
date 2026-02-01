/**
 * Module 1: Token Discovery
 *
 * Finds all Solana tokens that could have historically reached $10M market cap.
 *
 * Strategy: Three overlapping sweeps to maximize coverage:
 * 1. liquidity >= $10K — tokens with remaining pool depth
 * 2. holders >= 500   — distributed tokens (even if liquidity was drained)
 * 3. marketCap >= $50K — tokens with any remaining value
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
 * Discover ALL Solana tokens that could have historically reached $10M.
 *
 * The Codex filterTokens API only filters on *current* state, so tokens
 * that pumped to $10M+ and then completely died (zero liquidity, zero mcap)
 * can slip through. To maximise coverage we run many overlapping sweeps
 * with progressively lower thresholds, including a broad sweep of all
 * tokens created since Solana data start (March 2024) that still have
 * any holders or any remaining on-chain footprint.
 */
export async function discoverAllCandidates(
  client: GraphQLClient,
  config: CodexConfig,
  onProgress?: (fetched: number, total: number) => void,
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;
  const solanaStart = toUnixSeconds(SOLANA_DATA_START);

  const sweeps: SweepConfig[] = [
    // ── Tier 1: High-signal current-state sweeps ──
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

    // ── Tier 2: Catch tokens that have faded but still have some footprint ──
    {
      label: "holders >= 100 (created since Mar 2024)",
      filters: {
        network: [config.solanaNetworkId],
        holders: { gte: 100 },
        createdAt: { gte: solanaStart },
      },
      rankings: { attribute: "holders", direction: "DESC" },
    },
    {
      label: "liquidity >= $100 (created since Mar 2024)",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 100 },
        createdAt: { gte: solanaStart },
      },
      rankings: { attribute: "liquidity", direction: "DESC" },
    },
    {
      label: "marketCap >= $1K (created since Mar 2024)",
      filters: {
        network: [config.solanaNetworkId],
        marketCap: { gte: 1_000 },
        createdAt: { gte: solanaStart },
      },
      rankings: { attribute: "marketCap", direction: "DESC" },
    },
  ];

  const seen = new Set<string>();
  const allTokens: TokenInfo[] = [];
  let grandTotal = 0;

  for (const sweep of sweeps) {
    console.log(`  [discover] Sweep: ${sweep.label}`);

    // Probe for total count
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
    console.log(`  [discover]   ${sweepTotal.toLocaleString()} matching tokens`);
    grandTotal += sweepTotal;

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
        onProgress?.(allTokens.length + Math.min(offset + PAGE_SIZE, sweepTotal), grandTotal);
        return {
          results: data.filterTokens.results,
          count: data.filterTokens.count,
        };
      },
      PAGE_SIZE,
      1000 // up to 200K tokens per sweep
    );

    let newCount = 0;
    for (const r of results) {
      if (!seen.has(r.token.address)) {
        seen.add(r.token.address);
        allTokens.push(mapToTokenInfo(r));
        newCount++;
      }
    }
    console.log(`  [discover]   ${results.length} fetched, ${newCount} new (${allTokens.length} total unique)`);
  }

  console.log(`  [discover] Discovery complete: ${allTokens.length} unique candidate tokens from ${sweeps.length} sweeps`);
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
