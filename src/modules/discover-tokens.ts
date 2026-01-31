/**
 * Module 1: Token Discovery
 *
 * Finds all Solana tokens that have reached $10M market cap at any point.
 *
 * Strategy:
 * - Use filterTokens to pull ALL tokens above $10M mcap (full pagination).
 * - Also pull tokens currently between $1M–$10M with meaningful liquidity
 *   as historical candidates.
 * - Also pull tokens with high historical volume that may have decayed.
 *
 * Limitation: Codex only has Solana data from March 20, 2024 onward.
 */

import type { GraphQLClient } from "graphql-request";
import type { CodexConfig, TokenInfo } from "../types/index.js";
import { QUERIES, rateLimitedQuery } from "../client/codex.js";
import { paginateAll } from "../utils/helpers.js";

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

/**
 * Discover ALL Solana tokens currently at or above a market cap threshold.
 * Fully paginates — no page cap.
 */
export async function discoverCurrentTokensAboveThreshold(
  client: GraphQLClient,
  config: CodexConfig
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;

  console.log("  [discover] Fetching all tokens currently >= $10M market cap...");

  const results = await paginateAll<FilterTokenResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokensResponse>(
        client,
        QUERIES.FILTER_TOKENS,
        {
          filters: {
            network: [config.solanaNetworkId],
            marketCap: { gte: config.marketCapThreshold },
          },
          limit: PAGE_SIZE,
          offset,
        }
      );
      return {
        results: data.filterTokens.results,
        count: data.filterTokens.count,
      };
    },
    PAGE_SIZE
  );

  console.log(`  [discover] Found ${results.length} tokens currently above threshold`);
  return results.map(mapToTokenInfo);
}

/**
 * Discover tokens currently below the threshold that may have historically
 * crossed it. Multiple sweeps to maximize coverage since the API only filters
 * on CURRENT values — there's no "all-time high" market cap filter.
 *
 * A token that once hit $10M market cap will typically still have one of:
 * - Meaningful liquidity (even if mcap crashed)
 * - Significant holder count
 * - Some trading volume
 *
 * We cast a wide net and let Phase 2 (trajectory analysis) determine which
 * tokens actually crossed $10M historically via OHLCV data.
 */
export async function discoverHistoricalCandidates(
  client: GraphQLClient,
  config: CodexConfig
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;
  const allResults: FilterTokenResult[] = [];

  const sweeps: Array<{
    name: string;
    filters: Record<string, unknown>;
  }> = [
    // Sweep 1: $1M–$10M mcap with any meaningful liquidity
    {
      name: "tokens $1M-$10M mcap, liquidity > $50K",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 50_000 },
        marketCap: { gte: 1_000_000, lt: config.marketCapThreshold },
      },
    },
    // Sweep 2: $100K–$1M mcap with significant liquidity
    {
      name: "tokens $100K-$1M mcap, liquidity > $100K",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 100_000 },
        marketCap: { gte: 100_000, lt: 1_000_000 },
      },
    },
    // Sweep 3: Any mcap but very high liquidity (tokens that crashed but still liquid)
    {
      name: "any mcap, liquidity > $500K",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 500_000 },
      },
    },
    // Sweep 4: High holder count (tokens that attracted many wallets likely had high mcap)
    {
      name: "holders > 1000, mcap > $50K",
      filters: {
        network: [config.solanaNetworkId],
        holders: { gte: 1000 },
        marketCap: { gte: 50_000 },
      },
    },
    // Sweep 5: High 24h volume (active trading suggests relevance)
    {
      name: "volume24 > $500K",
      filters: {
        network: [config.solanaNetworkId],
        volume24: { gte: 500_000 },
      },
    },
    // Sweep 6: Very low mcap but still some liquidity (deep crash survivors)
    {
      name: "mcap $10K-$100K, liquidity > $50K",
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: 50_000 },
        marketCap: { gte: 10_000, lt: 100_000 },
      },
    },
  ];

  for (let i = 0; i < sweeps.length; i++) {
    const sweep = sweeps[i];
    console.log(`  [discover] Sweep ${i + 1}/${sweeps.length}: ${sweep.name}...`);
    try {
      const results = await paginateAll<FilterTokenResult>(
        async (offset) => {
          const data = await rateLimitedQuery<FilterTokensResponse>(
            client,
            QUERIES.FILTER_TOKENS,
            {
              filters: sweep.filters,
              limit: PAGE_SIZE,
              offset,
            }
          );
          return {
            results: data.filterTokens.results,
            count: data.filterTokens.count,
          };
        },
        PAGE_SIZE
      );
      console.log(`  [discover] Sweep ${i + 1}: found ${results.length} tokens`);
      allResults.push(...results);
    } catch (err) {
      console.error(`  [discover] Sweep ${i + 1} error:`, err);
    }
  }

  // Deduplicate by address
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    if (seen.has(r.token.address)) return false;
    seen.add(r.token.address);
    return true;
  });

  console.log(`  [discover] Found ${deduped.length} historical candidates (deduped from ${allResults.length})`);
  return deduped.map(mapToTokenInfo);
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
