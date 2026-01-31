/**
 * Solana Token Analysis — Main Orchestrator
 *
 * Research question: How many tokens in the Solana ecosystem hit $10M market cap,
 * how long they stay, what happens to holders, and how many survive?
 *
 * Usage:
 *   CODEX_API_KEY=<key> npx tsx src/index.ts
 */

import "dotenv/config";
import { createCodexClient } from "./client/codex.js";
import {
  discoverCurrentTokensAboveThreshold,
  discoverHistoricalCandidates,
} from "./modules/discover-tokens.js";
import { analyzeAllTrajectories } from "./modules/market-cap-trajectory.js";
import { analyzeAllTokenHolders } from "./modules/holder-analysis.js";
import { analyzeAllSurvivals } from "./modules/survival-analysis.js";
import { generateReport } from "./report.js";
import type { CodexConfig, TokenInfo } from "./types/index.js";
import { median, formatUsd } from "./utils/helpers.js";

function loadConfig(): CodexConfig {
  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) {
    console.error("ERROR: CODEX_API_KEY environment variable is required.");
    console.error("Get your key at https://dashboard.codex.io");
    process.exit(1);
  }

  return {
    apiKey,
    endpoint: "https://graph.codex.io/graphql",
    solanaNetworkId: parseInt(
      process.env.SOLANA_NETWORK_ID ?? "1399811149",
      10
    ),
    marketCapThreshold: parseInt(
      process.env.MARKET_CAP_THRESHOLD ?? "10000000",
      10
    ),
    liquiditySurvivalThreshold: parseInt(
      process.env.LIQUIDITY_SURVIVAL_THRESHOLD ?? "100000",
      10
    ),
  };
}

async function main() {
  const config = loadConfig();
  const client = createCodexClient(config);

  console.log("=".repeat(70));
  console.log("SOLANA TOKEN ECOSYSTEM ANALYSIS");
  console.log(`Threshold: ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`Survival: >${formatUsd(config.liquiditySurvivalThreshold)} liquidity`);
  console.log(`Data available from: March 20, 2024`);
  console.log("=".repeat(70));

  // ── Phase 1: Token Discovery ──────────────────────────────────────────
  console.log("\n[Phase 1] Discovering tokens...");

  const [currentTokens, historicalCandidates] = await Promise.all([
    discoverCurrentTokensAboveThreshold(client, config),
    discoverHistoricalCandidates(client, config),
  ]);

  // Merge and deduplicate
  const tokenMap = new Map<string, TokenInfo>();
  for (const t of [...currentTokens, ...historicalCandidates]) {
    tokenMap.set(t.address, t);
  }
  const allTokens = Array.from(tokenMap.values());

  console.log(`  Found ${currentTokens.length} tokens currently above ${formatUsd(config.marketCapThreshold)}`);
  console.log(`  Found ${historicalCandidates.length} additional candidates to check historically`);
  console.log(`  Total unique tokens to analyze: ${allTokens.length}`);

  // ── Phase 2: Market Cap Trajectory ────────────────────────────────────
  console.log("\n[Phase 2] Analyzing market cap trajectories...");
  const trajectories = await analyzeAllTrajectories(client, allTokens, config);

  // Filter to only tokens that actually hit the threshold
  const qualifiedTokens = allTokens.filter((t) => {
    const traj = trajectories.find((tr) => tr.tokenAddress === t.address);
    return traj?.reachedThreshold;
  });
  const qualifiedTrajectories = trajectories.filter((t) => t.reachedThreshold);

  console.log(`\n  RESULT: ${qualifiedTrajectories.length} tokens reached ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`  Currently above: ${qualifiedTrajectories.filter((t) => t.currentlyAbove).length}`);
  console.log(`  Avg days above threshold: ${(qualifiedTrajectories.reduce((s, t) => s + t.daysAboveThreshold, 0) / (qualifiedTrajectories.length || 1)).toFixed(1)}`);
  console.log(`  Median days above threshold: ${median(qualifiedTrajectories.map((t) => t.daysAboveThreshold))}`);

  // ── Phase 3: Holder Analysis ──────────────────────────────────────────
  console.log("\n[Phase 3] Analyzing holder profit/loss...");
  const holderAnalyses = await analyzeAllTokenHolders(
    client,
    qualifiedTokens.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      networkId: t.networkId,
    })),
    config
  );

  if (holderAnalyses.length > 0) {
    const totalHolders = holderAnalyses.reduce(
      (s, h) => s + h.totalHoldersAnalyzed,
      0
    );
    const totalInProfit = holderAnalyses.reduce(
      (s, h) => s + h.holdersInProfit,
      0
    );
    const avgTop10Profit =
      holderAnalyses.reduce(
        (s, h) => s + h.top10PercentStats.averageProfit,
        0
      ) / holderAnalyses.length;

    console.log(`\n  RESULT: ${totalHolders} wallets analyzed across ${holderAnalyses.length} tokens`);
    console.log(`  Overall in profit: ${totalInProfit} (${((totalInProfit / totalHolders) * 100).toFixed(1)}%)`);
    console.log(`  Overall in loss: ${totalHolders - totalInProfit} (${(((totalHolders - totalInProfit) / totalHolders) * 100).toFixed(1)}%)`);
    console.log(`  Avg top-10% profit per token: ${formatUsd(avgTop10Profit)}`);
  }

  // ── Phase 4: Survival Analysis ────────────────────────────────────────
  console.log("\n[Phase 4] Analyzing token survival...");
  const survivals = await analyzeAllSurvivals(
    client,
    qualifiedTokens,
    qualifiedTrajectories,
    config
  );

  const survival30 = survivals.filter((s) => s.checkpoints.days30 !== null);
  const survival90 = survivals.filter((s) => s.checkpoints.days90 !== null);
  const survival365 = survivals.filter((s) => s.checkpoints.days365 !== null);

  const alive30 = survival30.filter((s) => s.checkpoints.days30?.alive).length;
  const alive90 = survival90.filter((s) => s.checkpoints.days90?.alive).length;
  const alive365 = survival365.filter((s) => s.checkpoints.days365?.alive).length;

  console.log(`\n  SURVIVAL RATES (liquidity > ${formatUsd(config.liquiditySurvivalThreshold)}):`);
  console.log(`  30 days:  ${alive30}/${survival30.length} (${survival30.length > 0 ? ((alive30 / survival30.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  90 days:  ${alive90}/${survival90.length} (${survival90.length > 0 ? ((alive90 / survival90.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  365 days: ${alive365}/${survival365.length} (${survival365.length > 0 ? ((alive365 / survival365.length) * 100).toFixed(1) : "N/A"}%)`);

  // ── Phase 5: Generate Report ──────────────────────────────────────────
  console.log("\n[Phase 5] Generating report...");
  const report = generateReport(
    qualifiedTokens,
    qualifiedTrajectories,
    holderAnalyses,
    survivals,
    config
  );

  // Write report to stdout as JSON
  const reportJson = JSON.stringify(report, null, 2);
  const fs = await import("fs");
  fs.mkdirSync("reports", { recursive: true });
  const reportPath = `reports/analysis-${new Date().toISOString().split("T")[0]}.json`;
  fs.writeFileSync(reportPath, reportJson);
  console.log(`\n  Report saved to: ${reportPath}`);

  console.log("\n" + "=".repeat(70));
  console.log("ANALYSIS COMPLETE");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
