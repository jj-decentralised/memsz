/**
 * CSV Export — Generates flat CSV files from the analysis report
 * for use in external tools (DuckDB, BigQuery, Sheets, etc.)
 *
 * Two files:
 * - tokens.csv: one row per qualified token (trajectory + survival + aggregate P&L)
 * - wallets.csv: one row per wallet per token (individual P&L, cost basis, volume)
 */

import type { AggregateReport } from "../types/index.js";

function escapeCsv(val: unknown): string {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(values: unknown[]): string {
  return values.map(escapeCsv).join(",");
}

export function generateTokensCsv(report: AggregateReport): string {
  const header = [
    "address", "symbol",
    "reached_10m", "currently_above_10m",
    "peak_market_cap_usd", "current_market_cap_usd",
    "first_cross_timestamp", "peak_timestamp",
    "days_above_10m", "hours_above_10m",
    "total_holders_analyzed", "holders_in_profit", "holders_in_loss",
    "profit_percentage", "win_rate",
    "realized_profit_usd", "realized_loss_usd", "net_realized_usd",
    "unrealized_profit_usd", "unrealized_loss_usd", "net_unrealized_usd",
    "net_total_pnl_usd",
    "volume_bought_usd", "volume_sold_usd",
    "profit_factor", "avg_win_usd", "avg_loss_usd", "median_pnl_usd",
    "p25_pnl", "p75_pnl", "p90_pnl", "p99_pnl",
    "dist_big_loss", "dist_moderate_loss", "dist_breakeven", "dist_moderate_gain", "dist_big_gain",
    "liquidity_at_discovery", "current_liquidity", "currently_alive",
    "alive_30d", "alive_90d", "alive_365d",
  ];

  const lines = [header.join(",")];

  for (const td of report.tokenDetails) {
    const t = td.trajectory;
    const h = td.holders;
    const s = td.survival;
    const agg = h?.aggregatePnl;
    const econ = h?.econometrics;
    const dist = h?.pnlDistribution;

    lines.push(row([
      td.address, td.symbol,
      t?.reachedThreshold ?? false, t?.currentlyAbove ?? false,
      t?.peakMarketCap ?? 0, t?.currentMarketCap ?? 0,
      t?.firstCrossTimestamp ?? "", t?.peakTimestamp ?? "",
      t?.daysAboveThreshold ?? 0, t?.hoursAboveThreshold ?? 0,
      h?.totalHoldersAnalyzed ?? "", h?.holdersInProfit ?? "", h?.holdersInLoss ?? "",
      h?.profitPercentage ?? "", econ?.winRate ?? "",
      agg?.totalRealizedProfit ?? "", agg?.totalRealizedLoss ?? "", agg?.netRealized ?? "",
      agg?.totalUnrealizedProfit ?? "", agg?.totalUnrealizedLoss ?? "", agg?.netUnrealized ?? "",
      agg?.netTotal ?? "",
      agg?.totalVolumeBought ?? "", agg?.totalVolumeSold ?? "",
      econ?.profitFactor ?? "", econ?.avgWin ?? "", econ?.avgLoss ?? "", econ?.medianPnl ?? "",
      econ?.percentile25 ?? "", econ?.percentile75 ?? "", econ?.percentile90 ?? "", econ?.percentile99 ?? "",
      dist?.bigLoss ?? "", dist?.moderateLoss ?? "", dist?.breakeven ?? "", dist?.moderateGain ?? "", dist?.bigGain ?? "",
      s?.liquidityAtDiscovery ?? "", s?.currentLiquidity ?? "", s?.currentlyAlive ?? "",
      s?.checkpoints?.days30?.alive ?? "", s?.checkpoints?.days90?.alive ?? "", s?.checkpoints?.days365?.alive ?? "",
    ]));
  }

  return lines.join("\n");
}

export function generateWalletsCsv(report: AggregateReport): string {
  const header = [
    "token_address", "token_symbol", "wallet_address",
    "realized_pnl_usd", "unrealized_pnl_usd", "total_pnl_usd",
    "cost_basis_usd", "holding_value_usd",
    "amount_bought_usd", "amount_sold_usd",
    "buy_count", "sell_count", "in_profit",
  ];

  const lines = [header.join(",")];

  for (const td of report.tokenDetails) {
    if (!td.holders) continue;

    const allWallets = [
      ...(td.holders.topProfitWallets ?? []),
      ...(td.holders.topLossWallets ?? []),
    ];

    // Deduplicate (a wallet could theoretically appear in both lists)
    const seen = new Set<string>();
    for (const w of allWallets) {
      if (seen.has(w.walletAddress)) continue;
      seen.add(w.walletAddress);

      lines.push(row([
        td.address, td.symbol, w.walletAddress,
        w.realizedPnlUsd, w.unrealizedPnlUsd, w.totalPnlUsd,
        w.costBasisUsd, w.holdingValueUsd,
        w.amountBoughtUsd, w.amountSoldUsd,
        w.buyCount, w.sellCount, w.inProfit,
      ]));
    }
  }

  return lines.join("\n");
}
