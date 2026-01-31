import { GraphQLClient } from "graphql-request";
import type { CodexConfig } from "../types/index.js";

const CODEX_ENDPOINT = "https://graph.codex.io/graphql";

export function createCodexClient(config: CodexConfig): GraphQLClient {
  return new GraphQLClient(config.endpoint || CODEX_ENDPOINT, {
    headers: {
      Authorization: config.apiKey,
    },
  });
}

/** Rate-limited query wrapper to avoid hitting API limits */
export async function rateLimitedQuery<T>(
  client: GraphQLClient,
  query: string,
  variables: Record<string, unknown> = {},
  delayMs = 200
): Promise<T> {
  await sleep(delayMs);
  return client.request<T>(query, variables);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── GraphQL Query Strings ─────────────────────────────────────────────

export const QUERIES = {
  /**
   * filterTokens: discover Solana tokens sorted by market cap.
   * We use this to find tokens that have (or had) a $10M+ market cap.
   */
  FILTER_TOKENS: `
    query FilterTokens($filters: TokenFilters, $limit: Int, $offset: Int) {
      filterTokens(filters: $filters, limit: $limit, offset: $offset) {
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
        offset
      }
    }
  `,

  /**
   * getBars: OHLCV historical price data for a token pair.
   * Resolution options: 1, 5, 15, 30, 60, 240, 720, 1D
   */
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

  /**
   * getDetailedPairStats: granular stats for a pair over time buckets.
   */
  GET_DETAILED_PAIR_STATS: `
    query GetDetailedPairStats(
      $pairAddress: String!
      $networkId: Int!
      $tokenOfInterest: TokenOfInterest
      $statsType: TokenPairStatisticsType
      $timestamp: DetailedPairStatsInput
    ) {
      getDetailedPairStats(
        pairAddress: $pairAddress
        networkId: $networkId
        tokenOfInterest: $tokenOfInterest
        statsType: $statsType
        timestamp: $timestamp
      ) {
        stats_day1 {
          statsUsd {
            volume { currentValue }
            liquidity { currentValue }
            buyers { currentValue }
            sellers { currentValue }
          }
          timestamp
        }
      }
    }
  `,

  /**
   * filterTokenWallets: find wallets trading a specific token, ranked by PnL.
   */
  FILTER_TOKEN_WALLETS: `
    query FilterTokenWallets(
      $tokenAddress: String!
      $networkId: Int!
      $limit: Int
      $offset: Int
      $rankings: [TokenWalletRankingInput]
    ) {
      filterTokenWallets(
        tokenAddress: $tokenAddress
        networkId: $networkId
        limit: $limit
        offset: $offset
        rankings: $rankings
      ) {
        results {
          walletAddress
          realizedPnlUsd
          unrealizedPnlUsd
          buyCount
          sellCount
        }
        count
      }
    }
  `,

  /**
   * listPairsWithMetadataForToken: get all liquidity pairs for a token.
   */
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
          volume24
        }
      }
    }
  `,

  /** getNetworks: verify Solana network ID and supported networks */
  GET_NETWORKS: `
    query GetNetworks {
      getNetworks {
        id
        name
      }
    }
  `,
};
