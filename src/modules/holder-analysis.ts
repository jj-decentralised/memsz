/**
 * Module 3: Holder Profit/Loss Analysis
 *
 * For each token that hit $10M market cap, analyzes wallet-level PnL:
 * - How many holders are in profit vs loss
 * - Realized and unrealized P&L breakdown
 * - Top/bottom wallet performance
 * - Econometric distribution stats
 *
 * IMPORTANT: The Codex API returns most numeric fields as String!
 * All values must be parseFloat'd before any arithmetic.
 *
 * Supports configurable time windows: 30d or 1y (selected via analysisWindowDays).
 * Uses filterTokenWallets to get wallet PnL data for each token.
 * Pulls ALL wallets (no cap) for complete coverage.
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
  firstTransactionAt: number | null;
  lastTransactionAt: number | null;
  tokenBalance: string | null;
  tokenBalanceLiveUsd: string | null;
  tokenAcquisitionCostUsd: string | null;
  purchasedTokenBalance: string | null;
  // 1y fields
  realizedProfitUsd1y?: string | null;
  realizedProfitPercentage1y?: string | null;
  amountBoughtUsd1y?: string | null;
  amountSoldUsd1y?: string | null;
  buys1y?: number | null;
  sells1y?: number | null;
  // 30d fields
  realizedProfitUsd30d?: string | null;
  realizedProfitPercentage30d?: string | null;
  amountBoughtUsd30d?: string | null;
  amountSoldUsd30d?: string | null;
  buys30d?: number | null;
  sells30d?: number | null;
}

interface FilterTokenWalletsResponse {
  filterTokenWallets: {
    results: TokenWalletResult[];
    count: number;
  };
}

/** Safely parse a string or number from the API into a float. */
function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

type TimeSuffix = "30d" | "1y";

/** Pick time-window suffix based on analysisWindowDays */
function getTimeSuffix(analysisWindowDays?: number): TimeSuffix {
  if (analysisWindowDays != null && analysisWindowDays <= 30) return "30d";
  return "1y";
}

function getWalletQuery(suffix: TimeSuffix): string {
  return suffix === "30d"
    ? QUERIES.FILTER_TOKEN_WALLETS_30D
    : QUERIES.FILTER_TOKEN_WALLETS_1Y;
}

function getRankingAttribute(suffix: TimeSuffix): string {
  return suffix === "30d" ? "realizedProfitUsd30d" : "realizedProfitUsd1y";
}

/** Extract time-windowed fields from a wallet result */
function extractWindowedFields(r: TokenWalletResult, suffix: TimeSuffix) {
  if (suffix === "30d") {
    return {
      realized: num(r.realizedProfitUsd30d),
      amountBought: num(r.amountBoughtUsd30d),
      amountSold: num(r.amountSoldUsd30d),
      buys: r.buys30d ?? 0,
      sells: r.sells30d ?? 0,
    };
  }
  return {
    realized: num(r.realizedProfitUsd1y),
    amountBought: num(r.amountBoughtUsd1y),
    amountSold: num(r.amountSoldUsd1y),
    buys: r.buys1y ?? 0,
    sells: r.sells1y ?? 0,
  };
}

/**
 * Fetch wallet PnL data for a specific token.
 * Pulls ALL wallets — no artificial cap.
 */
async function fetchTokenWallets(
  client: GraphQLClient,
  tokenAddress: string,
  networkId: number,
  suffix: TimeSuffix,
): Promise<HolderPnL[]> {
  const PAGE_SIZE = 200;
  // Allow up to 500 pages (100K wallets) — effectively unlimited
  const maxPages = 500;

  const tokenId = `${tokenAddress}:${networkId}`;
  const query = getWalletQuery(suffix);
  const rankAttr = getRankingAttribute(suffix);

  const results = await paginateAll<TokenWalletResult>(
    async (offset) => {
      const data = await rateLimitedQuery<FilterTokenWalletsResponse>(
        client,
        query,
        {
          input: {
            tokenIds: [tokenId],
            networkId,
            limit: PAGE_SIZE,
            offset,
            rankings: [
              {
                attribute: rankAttr,
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

  return results.items.map((r) => {
    const w = extractWindowedFields(r, suffix);
    const holdingValue = num(r.tokenBalanceLiveUsd);
    const costBasis = num(r.tokenAcquisitionCostUsd);
    const unrealized = holdingValue - costBasis;
    const total = w.realized + unrealized;

    return {
      walletAddress: r.address,
      tokenAddress,
      realizedPnlUsd: w.realized,
      unrealizedPnlUsd: unrealized,
      totalPnlUsd: total,
      costBasisUsd: costBasis,
      holdingValueUsd: holdingValue,
      amountBoughtUsd: w.amountBought,
      amountSoldUsd: w.amountSold,
      buyCount: w.buys,
      sellCount: w.sells,
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
  networkId: number,
  analysisWindowDays?: number,
): Promise<TokenHolderAnalysis> {
  const suffix = getTimeSuffix(analysisWindowDays);
  const wallets = await fetchTokenWallets(client, tokenAddress, networkId, suffix);

  // Filter out wallets with zero activity (no buys, no sells, no cost basis, no realized PnL)
  // These are typically airdrop/transfer recipients with no meaningful PnL data
  const activeWallets = wallets.filter(
    (w) => w.buyCount > 0 || w.sellCount > 0 || w.costBasisUsd > 0 || Math.abs(w.realizedPnlUsd) > 0.01
  );

  const totalAnalyzed = activeWallets.length;
  const inProfit = activeWallets.filter((w) => w.totalPnlUsd > 0.01).length;
  const inLoss = activeWallets.filter((w) => w.totalPnlUsd < -0.01).length;
  const breakeven = totalAnalyzed - inProfit - inLoss;

  // Sort by total P&L descending
  const sortedByProfit = [...activeWallets].sort(
    (a, b) => b.totalPnlUsd - a.totalPnlUsd
  );

  // Top 10% analysis
  const top10Count = Math.max(1, Math.ceil(totalAnalyzed * 0.1));
  const top10Wallets = sortedByProfit.slice(0, top10Count);
  const top10Profits = top10Wallets.map((w) => w.totalPnlUsd);

  // Top 20 most profitable and bottom 20 biggest losers for profile pages
  const topProfitWallets = sortedByProfit.filter((w) => w.totalPnlUsd > 0).slice(0, 20);
  const topLossWallets = sortedByProfit.filter((w) => w.totalPnlUsd < 0).slice(-20).reverse();

  // Aggregate realized/unrealized across all wallets
  const totalRealizedProfit = activeWallets.reduce(
    (s, w) => s + (w.realizedPnlUsd > 0 ? w.realizedPnlUsd : 0), 0
  );
  const totalRealizedLoss = activeWallets.reduce(
    (s, w) => s + (w.realizedPnlUsd < 0 ? w.realizedPnlUsd : 0), 0
  );
  const totalUnrealizedProfit = activeWallets.reduce(
    (s, w) => s + (w.unrealizedPnlUsd > 0 ? w.unrealizedPnlUsd : 0), 0
  );
  const totalUnrealizedLoss = activeWallets.reduce(
    (s, w) => s + (w.unrealizedPnlUsd < 0 ? w.unrealizedPnlUsd : 0), 0
  );
  const totalVolumeBought = activeWallets.reduce((s, w) => s + w.amountBoughtUsd, 0);
  const totalVolumeSold = activeWallets.reduce((s, w) => s + w.amountSoldUsd, 0);

  // Percentile P&L values
  const allPnl = sortedByProfit.map((w) => w.totalPnlUsd);
  const p = (pct: number) => {
    if (allPnl.length === 0) return 0;
    const idx = Math.max(0, Math.ceil(allPnl.length * (1 - pct / 100)) - 1);
    return allPnl[idx];
  };

  // Average win vs average loss
  const wins = activeWallets.filter((w) => w.totalPnlUsd > 0.01);
  const losses = activeWallets.filter((w) => w.totalPnlUsd < -0.01);
  const avgWin = wins.length > 0 ? wins.reduce((s, w) => s + w.totalPnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, w) => s + w.totalPnlUsd, 0) / losses.length : 0;

  return {
    tokenAddress,
    symbol,
    totalWalletsFetched: wallets.length,
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
    aggregatePnl: {
      totalRealizedProfit,
      totalRealizedLoss,
      netRealized: totalRealizedProfit + totalRealizedLoss,
      totalUnrealizedProfit,
      totalUnrealizedLoss,
      netUnrealized: totalUnrealizedProfit + totalUnrealizedLoss,
      netTotal: totalRealizedProfit + totalRealizedLoss + totalUnrealizedProfit + totalUnrealizedLoss,
      totalVolumeBought,
      totalVolumeSold,
    },
    econometrics: {
      avgWin,
      avgLoss,
      profitFactor: Math.abs(totalRealizedLoss) > 0
        ? totalRealizedProfit / Math.abs(totalRealizedLoss)
        : totalRealizedProfit > 0 ? 999999 : 0,
      winRate: totalAnalyzed > 0 ? (inProfit / totalAnalyzed) * 100 : 0,
      medianPnl: median(allPnl),
      percentile25: p(25),
      percentile75: p(75),
      percentile90: p(90),
      percentile99: p(99),
    },
    pnlDistribution: computePnlDistribution(allPnl),
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
    else if (pnl < -100) dist.moderateLoss++;
    else if (pnl <= 100) dist.breakeven++;
    else if (pnl <= 10000) dist.moderateGain++;
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
  config: CodexConfig,
  onProgress?: (analysis: TokenHolderAnalysis, index: number, total: number) => void
): Promise<TokenHolderAnalysis[]> {
  const results: TokenHolderAnalysis[] = [];
  const suffix = getTimeSuffix(config.analysisWindowDays);
  console.log(`  [holders] Using ${suffix} time window for P&L data`);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      console.log(`  [holders] (${i + 1}/${tokens.length}) Analyzing ${token.symbol}...`);
      const analysis = await analyzeTokenHolders(
        client,
        token.address,
        token.symbol,
        token.networkId,
        config.analysisWindowDays,
      );
      results.push(analysis);
      const agg = analysis.aggregatePnl;
      console.log(
        `  [holders] ${token.symbol}: ${analysis.totalHoldersAnalyzed} active wallets ` +
          `(${analysis.profitPercentage.toFixed(1)}% profit) | ` +
          `realized: ${fmtUsd(agg.netRealized)} | unrealized: ${fmtUsd(agg.netUnrealized)} | ` +
          `top earner: ${fmtUsd(analysis.top10PercentStats.maxProfit)}`
      );
      onProgress?.(analysis, i, tokens.length);
    } catch (err) {
      console.error(`  [holders] Error analyzing ${token.symbol}:`, err);
    }
  }

  return results;
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
