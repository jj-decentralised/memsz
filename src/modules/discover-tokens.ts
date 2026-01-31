/**
 * Module 1: Token Discovery
 *
 * Finds all Solana tokens that have reached $10M market cap at any point.
 *
 * Strategy:
 * - Use filterTokens to pull tokens sorted by highest market cap (descending).
 * - Paginate until we fall below the $10M threshold.
 * - For tokens currently below $10M, we check historical price data via getBars
 *   to see if they ever crossed $10M (using current supply × historical price).
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
    offset: number;
  };
}

/**
 * Discover all Solana tokens currently at or above a market cap threshold.
 * This is step 1 — captures tokens that are currently above $10M.
 */
export async function discoverCurrentTokensAboveThreshold(
  client: GraphQLClient,
  config: CodexConfig
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;

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

  return results.map(mapToTokenInfo);
}

/**
 * Discover tokens that are currently below the threshold but may have
 * historically crossed it. We pull tokens with meaningful volume/liquidity
 * and then check their historical prices.
 *
 * This casts a wider net — tokens with >$1M liquidity at some point
 * are candidates that may have had $10M+ market cap historically.
 */
export async function discoverHistoricalCandidates(
  client: GraphQLClient,
  config: CodexConfig
): Promise<TokenInfo[]> {
  const PAGE_SIZE = 200;

  // Pull tokens with liquidity > $500K that might have once been at $10M mcap.
  // We use a lower liquidity threshold to catch tokens that have declined.
  const results = await paginateAll<FilterTokenResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokensResponse>(
        client,
        QUERIES.FILTER_TOKENS,
        {
          filters: {
            network: [config.solanaNetworkId],
            liquidity: { gte: 500_000 },
            marketCap: {
              gte: 1_000_000, // at least $1M now (likely was higher)
              lt: config.marketCapThreshold, // but below $10M now
            },
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
    PAGE_SIZE,
    25 // cap pages for candidates
  );

  return results.map(mapToTokenInfo);
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
