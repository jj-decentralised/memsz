/**
 * Report Generator
 *
 * Aggregates all analysis results into a structured report.
 */

import type {
  AggregateReport,
  DashboardReport,
  CodexConfig,
  MarketCapTrajectory,
  SurvivalAnalysis,
  TokenHolderAnalysis,
  TokenInfo,
} from "./types/index.js";
import { median, SOLANA_DATA_START } from "./utils/helpers.js";

export function generateReport(
  tokens: TokenInfo[],
  trajectories: MarketCapTrajectory[],
  holderAnalyses: TokenHolderAnalysis[],
  survivals: SurvivalAnalysis[],
  config: CodexConfig
): AggregateReport {
  const trajectoryMap = new Map(
    trajectories.map((t) => [t.tokenAddress, t])
  );
  const holderMap = new Map(
    holderAnalyses.map((h) => [h.tokenAddress, h])
  );
  const survivalMap = new Map(
    survivals.map((s) => [s.tokenAddress, s])
  );

  // Aggregate holder stats
  const allHolderCounts = holderAnalyses.map((h) => h.totalHoldersAnalyzed);
  const totalHolders = allHolderCounts.reduce((s, v) => s + v, 0);
  const totalInProfit = holderAnalyses.reduce(
    (s, h) => s + h.holdersInProfit,
    0
  );
  const totalInLoss = holderAnalyses.reduce(
    (s, h) => s + h.holdersInLoss,
    0
  );

  const top10Profits = holderAnalyses.map(
    (h) => h.top10PercentStats.averageProfit
  );
  const top10MaxProfits = holderAnalyses.map(
    (h) => h.top10PercentStats.maxProfit
  );

  // Survival aggregates
  const s30 = survivals.filter((s) => s.checkpoints.days30 !== null);
  const s90 = survivals.filter((s) => s.checkpoints.days90 !== null);
  const s365 = survivals.filter((s) => s.checkpoints.days365 !== null);

  const alive30 = s30.filter((s) => s.checkpoints.days30?.alive).length;
  const alive90 = s90.filter((s) => s.checkpoints.days90?.alive).length;
  const alive365 = s365.filter((s) => s.checkpoints.days365?.alive).length;

  // Days above threshold
  const daysAbove = trajectories.map((t) => t.daysAboveThreshold);

  const report: AggregateReport = {
    generatedAt: new Date().toISOString(),
    dataStartDate: SOLANA_DATA_START.toISOString(),
    parameters: {
      marketCapThreshold: config.marketCapThreshold,
      liquiditySurvivalThreshold: config.liquiditySurvivalThreshold,
      network: "Solana",
    },
    summary: {
      totalTokensAnalyzed: tokens.length,
      tokensReached10M: trajectories.filter((t) => t.reachedThreshold).length,
      tokensCurrentlyAbove10M: trajectories.filter((t) => t.currentlyAbove)
        .length,
      averageDaysAbove10M:
        daysAbove.length > 0
          ? daysAbove.reduce((s, v) => s + v, 0) / daysAbove.length
          : 0,
      medianDaysAbove10M: median(daysAbove),
    },
    holderSummary: {
      totalHoldersAnalyzed: totalHolders,
      overallProfitPercentage:
        totalHolders > 0 ? (totalInProfit / totalHolders) * 100 : 0,
      overallLossPercentage:
        totalHolders > 0 ? (totalInLoss / totalHolders) * 100 : 0,
      top10PercentAverageProfit:
        top10Profits.length > 0
          ? top10Profits.reduce((s, v) => s + v, 0) / top10Profits.length
          : 0,
      top10PercentMedianProfit: median(top10Profits),
      top10PercentMaxProfit: Math.max(0, ...top10MaxProfits),
    },
    survivalRates: {
      days30: {
        total: s30.length,
        alive: alive30,
        rate: s30.length > 0 ? (alive30 / s30.length) * 100 : 0,
      },
      days90: {
        total: s90.length,
        alive: alive90,
        rate: s90.length > 0 ? (alive90 / s90.length) * 100 : 0,
      },
      days365: {
        total: s365.length,
        alive: alive365,
        rate: s365.length > 0 ? (alive365 / s365.length) * 100 : 0,
      },
    },
    tokenDetails: tokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      trajectory: trajectoryMap.get(t.address)!,
      holders: holderMap.get(t.address) ?? null,
      survival: survivalMap.get(t.address)!,
    })),
  };

  return report;
}

/**
 * Generate a lightweight report for the dashboard by stripping
 * dailyMarketCaps arrays (which make up ~90% of the full report size).
 */
export function generateDashboardReport(report: AggregateReport): DashboardReport {
  return {
    ...report,
    tokenDetails: report.tokenDetails.map((td) => ({
      address: td.address,
      symbol: td.symbol,
      trajectory: td.trajectory ? (() => {
        const { dailyMarketCaps, ...rest } = td.trajectory;
        return rest;
      })() : td.trajectory,
      holders: td.holders,
      survival: td.survival,
    })),
  };
}
