import { GraphQLClient } from "graphql-request";
import type { CodexConfig } from "../types/index.js";

const CODEX_ENDPOINT = "https://graph.codex.io/graphql";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export function createCodexClient(config: CodexConfig): GraphQLClient {
  return new GraphQLClient(config.endpoint || CODEX_ENDPOINT, {
    headers: {
      Authorization: config.apiKey,
    },
  });
}

/**
 * Rate-limited query wrapper with exponential backoff retry.
 * Handles rate limits (429), server errors (5xx), and network failures.
 */
export async function rateLimitedQuery<T>(
  client: GraphQLClient,
  query: string,
  variables: Record<string, unknown> = {},
  delayMs = 250
): Promise<T> {
  await sleep(delayMs);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.request<T>(query, variables);
    } catch (err: unknown) {
      lastError = err;
      const retryable = isRetryable(err);
      if (!retryable) throw err;

      const backoff = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(
        `  [api] Request failed (attempt ${attempt + 1}/${MAX_RETRIES}), ` +
          `retrying in ${(backoff / 1000).toFixed(1)}s: ${extractMessage(err)}`
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = String((err as Record<string, unknown>).message ?? "");
  // Rate limit
  if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) return true;
  // Server errors
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
  // Network errors
  if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("fetch failed")) return true;
  // GraphQL throttle
  if (msg.toLowerCase().includes("throttle")) return true;
  return false;
}

function extractMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message).slice(0, 120);
  }
  return "Unknown error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── GraphQL Query Strings ─────────────────────────────────────────────

export const QUERIES = {
  FILTER_TOKENS: `
    query FilterTokens($filters: TokenFilters, $rankings: TokenRanking, $limit: Int, $offset: Int) {
      filterTokens(filters: $filters, rankings: $rankings, limit: $limit, offset: $offset) {
        results {
          token {
            address
            networkId
            name
            symbol
            totalSupply
            circulatingSupply
          }
          priceUSD
          marketCap
          liquidity
          volume24
          txnCount24
          holders
          pair {
            address
          }
        }
        count
      }
    }
  `,

  GET_BARS: `
    query GetBars($symbol: String!, $from: Int!, $to: Int!, $resolution: String!) {
      getBars(symbol: $symbol, from: $from, to: $to, resolution: $resolution) {
        o
        h
        l
        c
        v
        t
        s
      }
    }
  `,

  GET_TOKEN_BARS: `
    query GetTokenBars($symbol: String!, $from: Int!, $to: Int!, $resolution: String!, $removeLeadingNullValues: Boolean) {
      getTokenBars(symbol: $symbol, from: $from, to: $to, resolution: $resolution, removeLeadingNullValues: $removeLeadingNullValues) {
        o
        h
        l
        c
        v
        t
        s
      }
    }
  `,

  GET_DETAILED_PAIR_STATS: `
    query GetDetailedPairStats(
      $pairAddress: String!
      $networkId: Int!
      $tokenOfInterest: TokenOfInterest
      $statsType: TokenPairStatisticsType
      $timestamp: Int
      $bucketCount: Int
    ) {
      getDetailedPairStats(
        pairAddress: $pairAddress
        networkId: $networkId
        tokenOfInterest: $tokenOfInterest
        statsType: $statsType
        timestamp: $timestamp
        bucketCount: $bucketCount
      ) {
        stats_day1 {
          statsUsd {
            liquidity {
              currentValue
              buckets
            }
          }
          start
          end
        }
        stats_day30 {
          statsUsd {
            liquidity {
              currentValue
              buckets
            }
          }
          start
          end
        }
      }
    }
  `,

  FILTER_TOKEN_WALLETS_1Y: `
    query FilterTokenWallets($input: FilterTokenWalletsInput!) {
      filterTokenWallets(input: $input) {
        results {
          address
          firstTransactionAt
          lastTransactionAt
          tokenBalance
          tokenBalanceLiveUsd
          tokenAcquisitionCostUsd
          purchasedTokenBalance
          realizedProfitUsd1y
          realizedProfitPercentage1y
          amountBoughtUsd1y
          amountSoldUsd1y
          buys1y
          sells1y
        }
        count
        offset
      }
    }
  `,

  FILTER_TOKEN_WALLETS_30D: `
    query FilterTokenWallets($input: FilterTokenWalletsInput!) {
      filterTokenWallets(input: $input) {
        results {
          address
          firstTransactionAt
          lastTransactionAt
          tokenBalance
          tokenBalanceLiveUsd
          tokenAcquisitionCostUsd
          purchasedTokenBalance
          realizedProfitUsd30d
          realizedProfitPercentage30d
          amountBoughtUsd30d
          amountSoldUsd30d
          buys30d
          sells30d
        }
        count
        offset
      }
    }
  `,

  LIST_PAIRS_FOR_TOKEN: `
    query ListPairsForToken($tokenAddress: String!, $networkId: Int!) {
      listPairsWithMetadataForToken(
        tokenAddress: $tokenAddress
        networkId: $networkId
      ) {
        results {
          pair {
            address
            token0
            token1
          }
          liquidity
        }
      }
    }
  `,

  GET_NETWORKS: `
    query GetNetworks {
      getNetworks {
        id
        name
      }
    }
  `,
};
