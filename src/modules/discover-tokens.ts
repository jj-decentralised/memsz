/**
 * Module 1: Token Discovery
 *
 * Finds all Solana tokens that could have historically reached $10M market cap.
 *
 * Strategy:
 * - Single sweep: all Solana tokens with liquidity >= $10K, sorted by market
 *   cap descending. Any token that ever hit $10M would have attracted
 *   liquidity, and even dead tokens typically retain some LP remnants.
 * - Full pagination through ALL matching tokens.
 * - Phase 2 (trajectory analysis) validates which tokens actually crossed
 *   $10M using historical price bars.
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
 * Discover ALL Solana tokens with liquidity >= $10K as candidates
 * for the $10M market cap analysis. Sorted by market cap descending
 * and fully paginated.
 */
export async function discoverAllCandidates(
  client: GraphQLClient,
  config: CodexConfig,
  onProgress?: (fetched: number, total: number) => void,
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;
  const MIN_LIQUIDITY = 10_000; // $10K minimum liquidity

  console.log(`  [discover] Fetching all Solana tokens with liquidity >= $${MIN_LIQUIDITY.toLocaleString()}...`);

  // First, get the total count so we can report progress
  const probe = await rateLimitedQuery<FilterTokensResponse>(
    client,
    QUERIES.FILTER_TOKENS,
    {
      filters: {
        network: [config.solanaNetworkId],
        liquidity: { gte: MIN_LIQUIDITY },
      },
      rankings: { attribute: "liquidity", direction: "DESC" },
      limit: 1,
      offset: 0,
    }
  );
  const totalCount = probe.filterTokens.count;
  console.log(`  [discover] Total matching tokens: ${totalCount.toLocaleString()}`);

  const results = await paginateAll<FilterTokenResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokensResponse>(
        client,
        QUERIES.FILTER_TOKENS,
        {
          filters: {
            network: [config.solanaNetworkId],
            liquidity: { gte: MIN_LIQUIDITY },
          },
          rankings: { attribute: "liquidity", direction: "DESC" },
          limit: PAGE_SIZE,
          offset,
        }
      );
      onProgress?.(Math.min(offset + PAGE_SIZE, totalCount), totalCount);
      return {
        results: data.filterTokens.results,
        count: data.filterTokens.count,
      };
    },
    PAGE_SIZE,
    1000 // up to 200K tokens
  );

  // Deduplicate by address (shouldn't be needed with a single query, but safety)
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    if (seen.has(r.token.address)) return false;
    seen.add(r.token.address);
    return true;
  });

  console.log(`  [discover] Found ${deduped.length} candidate tokens`);
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

// Keep legacy exports for backward compatibility during transition
export const discoverCurrentTokensAboveThreshold = discoverAllCandidates;
export const discoverHistoricalCandidates = async () => [] as TokenInfo[];
