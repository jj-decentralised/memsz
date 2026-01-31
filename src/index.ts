/**
 * Solana Token Analysis — Main Orchestrator
 *
 * Runs as a Railway service:
 * - HTTP health check on PORT (Railway requirement)
 * - Full analysis pipeline with intermediate persistence
 * - Optional cron-triggered re-runs via CRON_SCHEDULE env var
 */

import "dotenv/config";
import { createServer } from "http";
import { createReadStream, existsSync } from "fs";
import { stat } from "fs/promises";
import { createCodexClient } from "./client/codex.js";
import {
  discoverCurrentTokensAboveThreshold,
  discoverHistoricalCandidates,
} from "./modules/discover-tokens.js";
import { analyzeAllTrajectories } from "./modules/market-cap-trajectory.js";
import { analyzeAllTokenHolders } from "./modules/holder-analysis.js";
import { analyzeAllSurvivals } from "./modules/survival-analysis.js";
import { generateReport, generateDashboardReport } from "./report.js";
import type { CodexConfig, TokenInfo, DashboardReport } from "./types/index.js";
import { median, formatUsd } from "./utils/helpers.js";
import { saveJson, loadJson, runFile, getFilePath, clearAllCache } from "./utils/store.js";
import { renderDashboard } from "./views/dashboard.js";

// ─── Global state for health check ──────────────────────────────────────

let status: {
  state: "idle" | "running" | "completed" | "error";
  phase: string;
  progress: string;
  lastRun: string | null;
  lastError: string | null;
  report: DashboardReport | null;
} = {
  state: "idle",
  phase: "startup",
  progress: "",
  lastRun: null,
  lastError: null,
  report: null,
};

// ─── Config ──────────────────────────────────────────────────────────────

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

// ─── Analysis Pipeline ──────────────────────────────────────────────────

async function runAnalysis() {
  status.state = "running";
  status.lastError = null;

  const config = loadConfig();
  const client = createCodexClient(config);

  console.log("=".repeat(70));
  console.log("SOLANA TOKEN ECOSYSTEM ANALYSIS");
  console.log(`Threshold: ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`Survival: >${formatUsd(config.liquiditySurvivalThreshold)} liquidity`);
  console.log(`Data available from: March 20, 2024`);
  console.log("=".repeat(70));

  // ── Phase 1: Token Discovery ────────────────────────────────────────
  status.phase = "Phase 1: Token Discovery";
  status.progress = "starting...";
  console.log("\n[Phase 1] Discovering tokens...");

  let allTokens: TokenInfo[];
  const cachedTokens = loadJson<TokenInfo[]>(runFile("tokens"));

  if (cachedTokens) {
    allTokens = cachedTokens;
    console.log(`  [cache] Loaded ${allTokens.length} tokens from today's cache`);
  } else {
    const [currentTokens, historicalCandidates] = await Promise.all([
      discoverCurrentTokensAboveThreshold(client, config),
      discoverHistoricalCandidates(client, config),
    ]);

    const tokenMap = new Map<string, TokenInfo>();
    for (const t of [...currentTokens, ...historicalCandidates]) {
      tokenMap.set(t.address, t);
    }
    allTokens = Array.from(tokenMap.values());

    console.log(`  Found ${currentTokens.length} tokens currently above ${formatUsd(config.marketCapThreshold)}`);
    console.log(`  Found ${historicalCandidates.length} additional candidates`);
    console.log(`  Total unique tokens: ${allTokens.length}`);

    saveJson(runFile("tokens"), allTokens);
  }

  status.progress = `${allTokens.length} tokens discovered`;

  // ── Phase 2: Market Cap Trajectory ──────────────────────────────────
  status.phase = "Phase 2: Market Cap Trajectories";
  status.progress = `0/${allTokens.length}`;
  console.log("\n[Phase 2] Analyzing market cap trajectories...");

  let trajectories = loadJson<any[]>(runFile("trajectories"));

  // Validate cache: if peak market caps look absurd (>$1T for a Solana token), data is bad
  if (trajectories) {
    const hasAbsurdMcap = trajectories.some((t: any) => (t.peakMarketCap ?? 0) > 1_000_000_000_000);
    if (hasAbsurdMcap) {
      console.log("  [cache] Trajectory cache has absurd market cap values — discarding stale data");
      trajectories = null;
    }
  }

  if (!trajectories) {
    trajectories = await analyzeAllTrajectories(client, allTokens, config, (_t, i, total) => {
      status.progress = `${i + 1}/${total}`;
    });
    saveJson(runFile("trajectories"), trajectories);
  } else {
    console.log(`  [cache] Loaded ${trajectories.length} trajectories from today's cache`);
  }

  const qualifiedTokens = allTokens.filter((t) => {
    const traj = trajectories!.find((tr: any) => tr.tokenAddress === t.address);
    return traj?.reachedThreshold;
  });
  const qualifiedTrajectories = trajectories.filter((t: any) => t.reachedThreshold);

  console.log(`\n  RESULT: ${qualifiedTrajectories.length} tokens reached ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`  Currently above: ${qualifiedTrajectories.filter((t: any) => t.currentlyAbove).length}`);
  console.log(`  Avg days above: ${(qualifiedTrajectories.reduce((s: number, t: any) => s + t.daysAboveThreshold, 0) / (qualifiedTrajectories.length || 1)).toFixed(1)}`);
  console.log(`  Median days above: ${median(qualifiedTrajectories.map((t: any) => t.daysAboveThreshold))}`);

  status.progress = `${qualifiedTrajectories.length} qualified tokens`;

  // ── Phase 3: Holder Analysis ────────────────────────────────────────
  status.phase = "Phase 3: Holder Profit/Loss";
  status.progress = `0/${qualifiedTokens.length}`;
  console.log("\n[Phase 3] Analyzing holder profit/loss...");

  let holderAnalyses = loadJson<any[]>(runFile("holders"));

  // Validate cache: if all entries have 0 wallets analyzed, the previous run failed
  if (holderAnalyses) {
    const totalWallets = holderAnalyses.reduce((s: number, h: any) => s + (h.totalHoldersAnalyzed ?? 0), 0);
    if (totalWallets === 0) {
      console.log("  [cache] Holder cache has 0 wallets — discarding stale data");
      holderAnalyses = null;
    }
  }

  if (!holderAnalyses) {
    holderAnalyses = await analyzeAllTokenHolders(
      client,
      qualifiedTokens.map((t) => ({
        address: t.address,
        symbol: t.symbol,
        networkId: t.networkId,
      })),
      config,
      (_a, i, total) => {
        status.progress = `${i + 1}/${total}`;
        // Save incremental progress every 10 tokens
        if ((i + 1) % 10 === 0) {
          saveJson(runFile("holders-partial"), holderAnalyses);
        }
      }
    );
    saveJson(runFile("holders"), holderAnalyses);
  } else {
    console.log(`  [cache] Loaded ${holderAnalyses.length} holder analyses from today's cache`);
  }

  if (holderAnalyses.length > 0) {
    const totalHolders = holderAnalyses.reduce((s: number, h: any) => s + h.totalHoldersAnalyzed, 0);
    const totalInProfit = holderAnalyses.reduce((s: number, h: any) => s + h.holdersInProfit, 0);
    const avgTop10Profit =
      holderAnalyses.reduce((s: number, h: any) => s + h.top10PercentStats.averageProfit, 0) /
      holderAnalyses.length;

    console.log(`\n  RESULT: ${totalHolders} wallets analyzed across ${holderAnalyses.length} tokens`);
    console.log(`  In profit: ${totalInProfit} (${((totalInProfit / totalHolders) * 100).toFixed(1)}%)`);
    console.log(`  In loss: ${totalHolders - totalInProfit} (${(((totalHolders - totalInProfit) / totalHolders) * 100).toFixed(1)}%)`);
    console.log(`  Avg top-10% profit: ${formatUsd(avgTop10Profit)}`);
  }

  // ── Phase 4: Survival Analysis ──────────────────────────────────────
  status.phase = "Phase 4: Survival Analysis";
  status.progress = `0/${qualifiedTokens.length}`;
  console.log("\n[Phase 4] Analyzing token survival...");

  let survivals = loadJson<any[]>(runFile("survivals"));

  // Validate cache: if no token has any checkpoint data, the previous run failed
  if (survivals) {
    const hasAnyCheckpoint = survivals.some((s: any) =>
      s.checkpoints?.days30 !== null || s.checkpoints?.days90 !== null || s.checkpoints?.days365 !== null || (s.currentLiquidity ?? 0) > 0
    );
    if (!hasAnyCheckpoint) {
      console.log("  [cache] Survival cache has no checkpoint data — discarding stale data");
      survivals = null;
    }
  }

  if (!survivals) {
    survivals = await analyzeAllSurvivals(
      client,
      qualifiedTokens,
      qualifiedTrajectories,
      config,
      (_s, i, total) => {
        status.progress = `${i + 1}/${total}`;
      }
    );
    saveJson(runFile("survivals"), survivals);
  } else {
    console.log(`  [cache] Loaded ${survivals.length} survival analyses from today's cache`);
  }

  const survival30 = survivals.filter((s: any) => s.checkpoints.days30 !== null);
  const survival90 = survivals.filter((s: any) => s.checkpoints.days90 !== null);
  const survival365 = survivals.filter((s: any) => s.checkpoints.days365 !== null);

  const alive30 = survival30.filter((s: any) => s.checkpoints.days30?.alive).length;
  const alive90 = survival90.filter((s: any) => s.checkpoints.days90?.alive).length;
  const alive365 = survival365.filter((s: any) => s.checkpoints.days365?.alive).length;

  console.log(`\n  SURVIVAL RATES (liquidity > ${formatUsd(config.liquiditySurvivalThreshold)}):`);
  console.log(`  30 days:  ${alive30}/${survival30.length} (${survival30.length > 0 ? ((alive30 / survival30.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  90 days:  ${alive90}/${survival90.length} (${survival90.length > 0 ? ((alive90 / survival90.length) * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  365 days: ${alive365}/${survival365.length} (${survival365.length > 0 ? ((alive365 / survival365.length) * 100).toFixed(1) : "N/A"}%)`);

  // ── Phase 5: Generate Report ────────────────────────────────────────
  status.phase = "Phase 5: Report";
  console.log("\n[Phase 5] Generating report...");

  const report = generateReport(
    qualifiedTokens,
    qualifiedTrajectories,
    holderAnalyses,
    survivals,
    config
  );

  saveJson(runFile("report"), report);
  saveJson("latest-report.json", report);

  // Save a lightweight dashboard version (strips dailyMarketCaps to reduce ~11MB → ~1MB)
  const dashboardReport = generateDashboardReport(report);
  saveJson("latest-dashboard.json", dashboardReport);

  status.state = "completed";
  status.phase = "done";
  status.lastRun = new Date().toISOString();
  // Only hold lightweight version in memory to avoid OOM
  status.report = dashboardReport;
  status.progress = `${qualifiedTrajectories.length} tokens analyzed`;

  console.log("\n" + "=".repeat(70));
  console.log("ANALYSIS COMPLETE");
  console.log("=".repeat(70));

  return report;
}

// ─── HTTP Health Check Server ───────────────────────────────────────────

function startHealthServer() {
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const server = createServer((req, res) => {
    if (req.url === "/") {
      // Load lightweight dashboard version (no dailyMarketCaps) to avoid OOM
      const report = status.report || loadJson<DashboardReport>("latest-dashboard.json");
      const html = renderDashboard(report, {
        state: status.state,
        phase: status.phase,
        progress: status.progress,
        lastRun: status.lastRun,
        lastError: status.lastError,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          state: status.state,
          phase: status.phase,
          progress: status.progress,
          lastRun: status.lastRun,
          lastError: status.lastError,
        })
      );
      return;
    }

    if (req.url === "/report/summary") {
      const report = status.report || loadJson<DashboardReport>("latest-dashboard.json");
      if (report) {
        const { tokenDetails, ...summary } = report;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary, null, 2));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No report available yet" }));
      }
      return;
    }

    if (req.url === "/report") {
      // Stream the report file from disk to avoid OOM on large reports
      const reportPath = getFilePath("latest-report.json");
      if (existsSync(reportPath)) {
        stat(reportPath).then((s) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": s.size,
          });
          createReadStream(reportPath).pipe(res);
        }).catch(() => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to read report file" }));
        });
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No report available yet" }));
      }
      return;
    }

    if (req.url === "/run" && req.method === "POST") {
      if (status.state === "running") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Analysis already running", phase: status.phase }));
        return;
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Analysis started" }));
      runAnalysis().catch((err) => {
        status.state = "error";
        status.lastError = String(err);
        console.error("Analysis failed:", err);
      });
      return;
    }

    if (req.url === "/clear-cache" && req.method === "POST") {
      const deleted = clearAllCache();
      status.report = null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Cache cleared", filesDeleted: deleted.length, files: deleted }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
    console.log(`  GET  /health  — service status`);
    console.log(`  GET  /report  — latest analysis report`);
    console.log(`  POST /run     — trigger a new analysis run`);
  });
}

// ─── Cron Scheduler ─────────────────────────────────────────────────────

function scheduleCron() {
  const intervalHours = parseInt(process.env.CRON_INTERVAL_HOURS ?? "24", 10);
  const intervalMs = intervalHours * 60 * 60 * 1000;

  console.log(`Scheduling analysis every ${intervalHours} hours`);

  setInterval(() => {
    if (status.state === "running") {
      console.log("[cron] Skipping — analysis already running");
      return;
    }
    console.log("[cron] Starting scheduled analysis run...");
    runAnalysis().catch((err) => {
      status.state = "error";
      status.lastError = String(err);
      console.error("[cron] Analysis failed:", err);
    });
  }, intervalMs);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Start the health check server first (Railway needs it)
  startHealthServer();

  // Run the first analysis immediately
  try {
    await runAnalysis();
  } catch (err) {
    status.state = "error";
    status.lastError = String(err);
    console.error("Initial analysis failed:", err);
  }

  // Schedule recurring runs
  if (process.env.CRON_INTERVAL_HOURS) {
    scheduleCron();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
