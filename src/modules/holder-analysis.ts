/**
 * Module 3: Holder Profit/Loss Analysis
 *
 * For each token that hit $10M market cap, analyzes wallet-level PnL:
 * - How many holders are in profit vs loss
 * - What the top 10% earners made
 * - PnL distribution across all holders
 *
 * Uses filterTokenWallets to get wallet PnL data for each token.
 * Pulls up to 5000 wallets per token for complete coverage.
 */

import type { GraphQLClient } from "graphql-request";
import type {
  CodexConfig,
  HolderPnL,
  TokenHolderAnalysis,
} from "../types/index.js";
import { QUERIES, rateLimitedQuery } from "../client/codex.js";
import { paginateAll, median } from "../utils/helpers.js";

interface TokenWalletResult {
  address: string;
  realizedProfitUsd1y: number | null;
  realizedProfitPercentage1y: number | null;
  tokenBalanceLiveUsd: number | null;
  tokenAcquisitionCostUsd: number | null;
  buys1y: number | null;
  sells1y: number | null;
}

interface FilterTokenWalletsResponse {
  filterTokenWallets: {
    results: TokenWalletResult[];
    count: number;
  };
}

/**
 * Fetch wallet PnL data for a specific token.
 * Pulls up to maxWallets (default 5000) for thorough coverage.
 */
async function fetchTokenWallets(
  client: GraphQLClient,
  tokenAddress: string,
  networkId: number,
  maxWallets = 5000
): Promise<HolderPnL[]> {
  const PAGE_SIZE = 200;
  const maxPages = Math.ceil(maxWallets / PAGE_SIZE);

  const tokenId = `${tokenAddress}:${networkId}`;

  const results = await paginateAll<TokenWalletResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokenWalletsResponse>(
        client,
        QUERIES.FILTER_TOKEN_WALLETS,
        {
          input: {
            tokenIds: [tokenId],
            networkId,
            limit: PAGE_SIZE,
            offset,
            rankings: [
              {
                attribute: "realizedProfitUsd1y",
                direction: "DESC",
              },
            ],
          },
        }
      );
      return {
        results: data.filterTokenWallets.results,
        count: data.filterTokenWallets.count,
      };
    },
    PAGE_SIZE,
    maxPages
  );

  return results.map((r) => {
    const realized = r.realizedProfitUsd1y ?? 0;
    // Unrealized = current value of holdings - acquisition cost
    const unrealized = (r.tokenBalanceLiveUsd ?? 0) - (r.tokenAcquisitionCostUsd ?? 0);
    const total = realized + unrealized;
    return {
      walletAddress: r.address,
      tokenAddress,
      realizedPnlUsd: realized,
      unrealizedPnlUsd: unrealized,
      totalPnlUsd: total,
      buyCount: r.buys1y ?? 0,
      sellCount: r.sells1y ?? 0,
      inProfit: total > 0,
    };
  });
}

/**
 * Analyze holder PnL distribution for a single token.
 */
export async function analyzeTokenHolders(
  client: GraphQLClient,
  tokenAddress: string,
  symbol: string,
  networkId: number
): Promise<TokenHolderAnalysis> {
  const wallets = await fetchTokenWallets(client, tokenAddress, networkId);

  const totalAnalyzed = wallets.length;
  const inProfit = wallets.filter((w) => w.totalPnlUsd > 0).length;
  const inLoss = wallets.filter((w) => w.totalPnlUsd < 0).length;
  const breakeven = wallets.filter((w) => w.totalPnlUsd === 0).length;

  // Top 10% analysis
  const sortedByProfit = [...wallets].sort(
    (a, b) => b.totalPnlUsd - a.totalPnlUsd
  );
  const top10Count = Math.max(1, Math.ceil(totalAnalyzed * 0.1));
  const top10Wallets = sortedByProfit.slice(0, top10Count);
  const top10Profits = top10Wallets.map((w) => w.totalPnlUsd);

  const pnlValues = wallets.map((w) => w.totalPnlUsd);

  // Top 20 most profitable and bottom 20 biggest losers for profile pages
  const topProfitWallets = sortedByProfit.slice(0, 20);
  const topLossWallets = sortedByProfit.slice(-20).reverse();

  return {
    tokenAddress,
    symbol,
    totalHoldersAnalyzed: totalAnalyzed,
    holdersInProfit: inProfit,
    holdersInLoss: inLoss,
    holdersBreakeven: breakeven,
    profitPercentage:
      totalAnalyzed > 0 ? (inProfit / totalAnalyzed) * 100 : 0,
    top10PercentStats: {
      count: top10Count,
      totalProfit: top10Profits.reduce((s, v) => s + v, 0),
      averageProfit:
        top10Count > 0
          ? top10Profits.reduce((s, v) => s + v, 0) / top10Count
          : 0,
      medianProfit: median(top10Profits),
      maxProfit: top10Profits[0] ?? 0,
      minProfitInTopDecile: top10Profits[top10Profits.length - 1] ?? 0,
    },
    pnlDistribution: computePnlDistribution(pnlValues),
    topProfitWallets,
    topLossWallets,
  };
}

function computePnlDistribution(
  pnlValues: number[]
): TokenHolderAnalysis["pnlDistribution"] {
  const dist = {
    bigLoss: 0,
    moderateLoss: 0,
    breakeven: 0,
    moderateGain: 0,
    bigGain: 0,
  };

  for (const pnl of pnlValues) {
    if (pnl < -1000) dist.bigLoss++;
    else if (pnl < -10) dist.moderateLoss++;
    else if (pnl <= 10) dist.breakeven++;
    else if (pnl <= 1000) dist.moderateGain++;
    else dist.bigGain++;
  }

  return dist;
}

/**
 * Batch analyze holders for multiple tokens.
 * Saves progress after each token so partial results survive crashes.
 */
export async function analyzeAllTokenHolders(
  client: GraphQLClient,
  tokens: Array<{ address: string; symbol: string; networkId: number }>,
  _config: CodexConfig,
  onProgress?: (analysis: TokenHolderAnalysis, index: number, total: number) => void
): Promise<TokenHolderAnalysis[]> {
  const results: TokenHolderAnalysis[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      console.log(`  [holders] (${i + 1}/${tokens.length}) Analyzing ${token.symbol}...`);
      const analysis = await analyzeTokenHolders(
        client,
        token.address,
        token.symbol,
        token.networkId
      );
      results.push(analysis);
      console.log(
        `  [holders] ${token.symbol}: ${analysis.holdersInProfit}/${analysis.totalHoldersAnalyzed} in profit ` +
          `(${analysis.profitPercentage.toFixed(1)}%), top10% avg=${formatUsd(analysis.top10PercentStats.averageProfit)}`
      );
      onProgress?.(analysis, i, tokens.length);
    } catch (err) {
      console.error(`  [holders] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}

function formatUsd(v: number): string {
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
