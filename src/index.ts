/**
 * Solana Token Analysis — Main Orchestrator
 *
 * Runs as a Railway service:
 * - HTTP health check on PORT (Railway requirement)
 * - Full analysis pipeline with per-token incremental persistence
 * - Detailed progress tracking with ETA
 * - Periodic backup snapshots to Railway volume
 * - /progress endpoint for live monitoring
 * - Optional cron-triggered re-runs via CRON_SCHEDULE env var
 */

import "dotenv/config";
import { createServer } from "http";
import { createReadStream, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { createCodexClient } from "./client/codex.js";
import {
  discoverAllCandidates,
} from "./modules/discover-tokens.js";
import { analyzeTrajectoryHourly, weeklyPreScreen } from "./modules/market-cap-trajectory.js";
import { analyzeTokenHolders } from "./modules/holder-analysis.js";
import { analyzeSurvival } from "./modules/survival-analysis.js";
import { generateReport, generateDashboardReport } from "./report.js";
import type {
  CodexConfig,
  TokenInfo,
  DashboardReport,
  AggregateReport,
  MarketCapTrajectory,
  TokenHolderAnalysis,
  SurvivalAnalysis,
} from "./types/index.js";
import { median, formatUsd, parallelMap } from "./utils/helpers.js";
import {
  saveJson,
  loadJson,
  runFile,
  getFilePath,
  clearAllCache,
  saveTokenResult,
  loadTokenResult,
  getCompletedTokens,
  loadAllTokenResults,
  saveManifest,
  loadManifest,
  createBackupSnapshot,
  listBackups,
  loadVersionStamp,
  saveVersionStamp,
} from "./utils/store.js";
import { generateTokensCsv, generateWalletsCsv } from "./utils/csv-export.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderTokenProfile } from "./views/token-profile.js";

// ─── Progress Tracking ──────────────────────────────────────────────────

interface PhaseProgress {
  name: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  total: number;
  completed: number;
  skipped: number;
  errors: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Rolling average ms per item (for ETA) */
  avgMsPerItem: number;
  /** Last few item durations for rolling average */
  recentDurations: number[];
}

interface RunProgress {
  runId: string;
  startedAt: string;
  currentPhase: string;
  phases: {
    discovery: PhaseProgress;
    weeklyScreen: PhaseProgress;
    hourlyAnalysis: PhaseProgress;
    holders: PhaseProgress;
    survival: PhaseProgress;
    report: PhaseProgress;
  };
  apiCallsEstimate: number;
  totalTokensDiscovered: number;
  totalWeeklyPassed: number;
  totalQualified: number;
  lastBackupAt: string | null;
  backupCount: number;
}

function createPhaseProgress(name: string): PhaseProgress {
  return {
    name,
    status: "pending",
    total: 0,
    completed: 0,
    skipped: 0,
    errors: 0,
    startedAt: null,
    completedAt: null,
    avgMsPerItem: 0,
    recentDurations: [],
  };
}

function updateEta(phase: PhaseProgress, durationMs: number): void {
  phase.recentDurations.push(durationMs);
  // Keep last 20 durations for rolling average
  if (phase.recentDurations.length > 20) {
    phase.recentDurations.shift();
  }
  phase.avgMsPerItem =
    phase.recentDurations.reduce((s, d) => s + d, 0) / phase.recentDurations.length;
}

function formatEta(phase: PhaseProgress): string {
  const remaining = phase.total - phase.completed - phase.skipped - phase.errors;
  if (remaining <= 0 || phase.avgMsPerItem <= 0) return "N/A";
  const etaMs = remaining * phase.avgMsPerItem;
  const etaMin = etaMs / 60000;
  if (etaMin < 1) return "<1 min";
  if (etaMin < 60) return `~${Math.ceil(etaMin)} min`;
  const hours = Math.floor(etaMin / 60);
  const mins = Math.ceil(etaMin % 60);
  return `~${hours}h ${mins}m`;
}

function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const min = Math.floor(elapsed / 60000);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  return `${hours}h ${mins}m`;
}

// ─── Global state ───────────────────────────────────────────────────────

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

let runProgress: RunProgress | null = null;

// ─── Backup interval ────────────────────────────────────────────────────

const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // Every 30 minutes
let lastBackupTime = 0;

function maybeBackup(): void {
  const now = Date.now();
  if (now - lastBackupTime >= BACKUP_INTERVAL_MS) {
    try {
      createBackupSnapshot();
      lastBackupTime = now;
      if (runProgress) {
        runProgress.lastBackupAt = new Date().toISOString();
        runProgress.backupCount++;
      }
    } catch (err) {
      console.error("  [backup] Failed to create snapshot:", err);
    }
  }
}

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
    analysisWindowDays: process.env.ANALYSIS_WINDOW_DAYS
      ? parseInt(process.env.ANALYSIS_WINDOW_DAYS, 10)
      : undefined,
  };
}

// ─── Analysis Pipeline ──────────────────────────────────────────────────

async function runAnalysis() {
  status.state = "running";
  status.lastError = null;

  const config = loadConfig();
  const client = createCodexClient(config);

  const runId = new Date().toISOString().split("T")[0];
  runProgress = {
    runId,
    startedAt: new Date().toISOString(),
    currentPhase: "discovery",
    phases: {
      discovery: createPhaseProgress("Token Discovery"),
      weeklyScreen: createPhaseProgress("Weekly Pre-Screen"),
      hourlyAnalysis: createPhaseProgress("Hourly Analysis"),
      holders: createPhaseProgress("Holder P&L Analysis"),
      survival: createPhaseProgress("Survival Analysis"),
      report: createPhaseProgress("Report Generation"),
    },
    apiCallsEstimate: 0,
    totalTokensDiscovered: 0,
    totalWeeklyPassed: 0,
    totalQualified: 0,
    lastBackupAt: null,
    backupCount: 0,
  };

  const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "10", 10);

  console.log("=".repeat(70));
  console.log("SOLANA TOKEN ECOSYSTEM ANALYSIS");
  console.log(`Threshold: ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`Survival: >${formatUsd(config.liquiditySurvivalThreshold)} liquidity`);
  console.log(`Analysis window: ${config.analysisWindowDays ? config.analysisWindowDays + " days" : "all available (March 2024 – present)"}`);
  console.log(`Data available from: March 20, 2024`);
  console.log(`Concurrency: ${CONCURRENCY} parallel workers`);
  console.log("=".repeat(70));

  // ── Phase 1: Token Discovery ────────────────────────────────────────
  runProgress.currentPhase = "discovery";
  const pDiscovery = runProgress.phases.discovery;
  pDiscovery.status = "in_progress";
  pDiscovery.startedAt = new Date().toISOString();
  status.phase = "Phase 1: Token Discovery";
  status.progress = "starting...";
  console.log("\n[Phase 1] Discovering all Solana tokens (6 overlapping sweeps)...");

  // Discovery cache is versioned — bump DISCOVERY_VERSION when sweep config changes
  // to force a fresh discovery run even if today's cache exists.
  const DISCOVERY_VERSION = 13; // v13=all sweeps require mcap >= $1M to avoid screening 200K+ irrelevant tokens
  const discoveryCacheKey = `${runFile("tokens")}.v${DISCOVERY_VERSION}`;

  // Auto-clear all cached data when version changes (no manual cache clear needed)
  const lastVersion = loadVersionStamp();
  if (lastVersion !== DISCOVERY_VERSION) {
    console.log(`  [auto-clear] Version changed (${lastVersion ?? "none"} → ${DISCOVERY_VERSION}), clearing all cached data...`);
    clearAllCache();
    saveVersionStamp(DISCOVERY_VERSION);
  }

  let allTokens: TokenInfo[];
  const cachedTokens = loadJson<TokenInfo[]>(discoveryCacheKey);

  if (cachedTokens) {
    allTokens = cachedTokens;
    console.log(`  [cache] Loaded ${allTokens.length} tokens from today's cache (v${DISCOVERY_VERSION})`);
  } else {
    allTokens = await discoverAllCandidates(client, config, (fetched, total) => {
      pDiscovery.total = total;
      pDiscovery.completed = fetched;
      status.progress = `${fetched.toLocaleString()}/${total.toLocaleString()} tokens`;
    });
    console.log(`  Total candidate tokens: ${allTokens.length}`);
    saveJson(discoveryCacheKey, allTokens);
  }

  pDiscovery.total = allTokens.length;
  pDiscovery.completed = allTokens.length;
  pDiscovery.status = "completed";
  pDiscovery.completedAt = new Date().toISOString();
  runProgress.totalTokensDiscovered = allTokens.length;
  status.progress = `${allTokens.length} candidates discovered`;

  // ── Phase 2a: Weekly Pre-Screen ───────────────────────────────────
  runProgress.currentPhase = "weeklyScreen";
  const pWeekly = runProgress.phases.weeklyScreen;
  pWeekly.status = "in_progress";
  pWeekly.startedAt = new Date().toISOString();
  pWeekly.total = allTokens.length;
  status.phase = "Phase 2a: Weekly Pre-Screen";
  status.progress = `0/${allTokens.length}`;
  console.log(`\n[Phase 2a] Weekly pre-screen for ${allTokens.length} candidates...`);

  // Load already-completed weekly screens
  const weeklyCompleted = getCompletedTokens("weekly");
  console.log(`  [resume] ${weeklyCompleted.size} tokens already screened from previous run`);
  pWeekly.completed = weeklyCompleted.size;

  const weeklyPassed: Array<{ token: TokenInfo; estimatedPeakMcap: number }> = [];

  // Re-load previously passed tokens
  for (const token of allTokens) {
    if (weeklyCompleted.has(token.address)) {
      const cached = loadTokenResult<{ passed: boolean; estimatedPeakMcap: number }>("weekly", token.address);
      if (cached?.passed) {
        weeklyPassed.push({ token, estimatedPeakMcap: cached.estimatedPeakMcap });
      }
    }
  }

  // Screen remaining tokens (parallel)
  const weeklyTodo = allTokens.filter((t) => !weeklyCompleted.has(t.address));
  console.log(`  [weekly] ${weeklyTodo.length} tokens to screen (${CONCURRENCY} workers)...`);

  await parallelMap(weeklyTodo, async (token) => {
    try {
      const itemStart = Date.now();
      const result = await weeklyPreScreen(client, token, config);
      saveTokenResult("weekly", token.address, result);

      if (result.passed) {
        weeklyPassed.push({ token, estimatedPeakMcap: result.estimatedPeakMcap });
      }

      pWeekly.completed++;
      updateEta(pWeekly, Date.now() - itemStart);

      if (pWeekly.completed % 200 === 0 || pWeekly.completed === 1) {
        const eta = formatEta(pWeekly);
        console.log(
          `  [weekly] (${pWeekly.completed}/${pWeekly.total}) ` +
          `${weeklyPassed.length} passed so far | ETA: ${eta}`
        );
        status.progress = `${pWeekly.completed}/${pWeekly.total} screened, ${weeklyPassed.length} passed | ETA: ${eta}`;
      }

      maybeBackup();
    } catch (err) {
      pWeekly.errors++;
      console.error(`  [weekly] Error screening ${token.symbol}:`, err);
    }
  }, CONCURRENCY);

  pWeekly.status = "completed";
  pWeekly.completedAt = new Date().toISOString();
  runProgress.totalWeeklyPassed = weeklyPassed.length;

  console.log(`  [Phase 2a] Complete: ${weeklyPassed.length} of ${allTokens.length} passed weekly pre-screen`);

  // Sort by estimated peak market cap (most promising first)
  weeklyPassed.sort((a, b) => b.estimatedPeakMcap - a.estimatedPeakMcap);

  // ── Phase 2b: Hourly Precision Analysis ───────────────────────────
  runProgress.currentPhase = "hourlyAnalysis";
  const pHourly = runProgress.phases.hourlyAnalysis;
  pHourly.status = "in_progress";
  pHourly.startedAt = new Date().toISOString();
  pHourly.total = weeklyPassed.length;
  status.phase = "Phase 2b: Hourly Analysis";
  status.progress = `0/${weeklyPassed.length}`;
  console.log(`\n[Phase 2b] Hourly analysis for ${weeklyPassed.length} candidates...`);

  // Load already-completed hourly analyses
  const hourlyCompleted = getCompletedTokens("hourly");
  console.log(`  [resume] ${hourlyCompleted.size} tokens already analyzed from previous run`);

  const trajectories: MarketCapTrajectory[] = [];

  // Re-load previously completed trajectories
  for (const { token } of weeklyPassed) {
    if (hourlyCompleted.has(token.address)) {
      const cached = loadTokenResult<MarketCapTrajectory>("hourly", token.address);
      if (cached) {
        trajectories.push(cached);
        pHourly.completed++;
      }
    }
  }

  // Analyze remaining tokens (parallel)
  const hourlyTodo = weeklyPassed.filter(({ token }) => !hourlyCompleted.has(token.address));
  console.log(`  [hourly] ${hourlyTodo.length} tokens to analyze (${CONCURRENCY} workers)...`);

  await parallelMap(hourlyTodo, async ({ token, estimatedPeakMcap }) => {
    try {
      const itemStart = Date.now();
      console.log(
        `  [hourly] (${pHourly.completed + 1}/${pHourly.total}) ` +
        `Analyzing ${token.symbol} (est. peak ${formatMcap(estimatedPeakMcap)})...`
      );

      const trajectory = await analyzeTrajectoryHourly(client, token, config);
      saveTokenResult("hourly", token.address, trajectory);
      trajectories.push(trajectory);

      pHourly.completed++;
      updateEta(pHourly, Date.now() - itemStart);

      console.log(
        `  [hourly] ${token.symbol}: reached=${trajectory.reachedThreshold}, ` +
        `peak=${formatMcap(trajectory.peakMarketCap)}, ` +
        `hours_above=${trajectory.hoursAboveThreshold}, ` +
        `days_above=${trajectory.daysAboveThreshold} | ` +
        `ETA: ${formatEta(pHourly)}`
      );

      status.progress = `${pHourly.completed}/${pHourly.total} | ETA: ${formatEta(pHourly)}`;
      maybeBackup();
    } catch (err) {
      pHourly.errors++;
      console.error(`  [hourly] Error analyzing ${token.symbol}:`, err);
    }
  }, CONCURRENCY);

  pHourly.status = "completed";
  pHourly.completedAt = new Date().toISOString();

  // Also save the full trajectories file for report generation
  saveJson(runFile("trajectories"), trajectories);

  const qualifiedTokens = allTokens.filter((t) => {
    const traj = trajectories.find((tr) => tr.tokenAddress === t.address);
    return traj?.reachedThreshold;
  });
  const qualifiedTrajectories = trajectories.filter((t) => t.reachedThreshold);
  runProgress.totalQualified = qualifiedTrajectories.length;

  console.log(`\n  RESULT: ${qualifiedTrajectories.length} tokens reached ${formatUsd(config.marketCapThreshold)} market cap`);
  console.log(`  Currently above: ${qualifiedTrajectories.filter((t) => t.currentlyAbove).length}`);
  console.log(`  Avg hours above: ${(qualifiedTrajectories.reduce((s, t) => s + (t.hoursAboveThreshold ?? 0), 0) / (qualifiedTrajectories.length || 1)).toFixed(1)}`);
  console.log(`  Median days above: ${median(qualifiedTrajectories.map((t) => t.daysAboveThreshold))}`);

  // Backup after Phase 2 completes
  createBackupSnapshot();
  if (runProgress) {
    runProgress.lastBackupAt = new Date().toISOString();
    runProgress.backupCount++;
  }

  // ── Phase 3: Holder Analysis (per-token incremental) ──────────────
  runProgress.currentPhase = "holders";
  const pHolders = runProgress.phases.holders;
  pHolders.status = "in_progress";
  pHolders.startedAt = new Date().toISOString();
  pHolders.total = qualifiedTokens.length;
  status.phase = "Phase 3: Holder P&L Analysis";
  status.progress = `0/${qualifiedTokens.length}`;
  console.log(`\n[Phase 3] Analyzing holder profit/loss for ${qualifiedTokens.length} qualified tokens...`);

  // Load already-completed holder analyses
  const holdersCompleted = getCompletedTokens("holders");
  console.log(`  [resume] ${holdersCompleted.size} tokens already analyzed from previous run`);

  const holderAnalyses: TokenHolderAnalysis[] = [];

  // Re-load previously completed analyses
  for (const token of qualifiedTokens) {
    if (holdersCompleted.has(token.address)) {
      const cached = loadTokenResult<TokenHolderAnalysis>("holders", token.address);
      if (cached && cached.aggregatePnl) {
        holderAnalyses.push(cached);
        pHolders.completed++;
      }
    }
  }

  // Analyze remaining tokens (parallel)
  const holdersTodo = qualifiedTokens.filter((t) => {
    if (holdersCompleted.has(t.address)) {
      return !holderAnalyses.some((h) => h.tokenAddress === t.address);
    }
    return true;
  });
  console.log(`  [holders] ${holdersTodo.length} tokens to analyze (${CONCURRENCY} workers)...`);

  await parallelMap(holdersTodo, async (token) => {
    try {
      const itemStart = Date.now();
      console.log(
        `  [holders] (${pHolders.completed + 1}/${pHolders.total}) ` +
        `Analyzing ${token.symbol}...`
      );

      const analysis = await analyzeTokenHolders(
        client,
        token.address,
        token.symbol,
        token.networkId,
        config.analysisWindowDays,
      );

      saveTokenResult("holders", token.address, analysis);
      holderAnalyses.push(analysis);

      pHolders.completed++;
      updateEta(pHolders, Date.now() - itemStart);

      const agg = analysis.aggregatePnl;
      console.log(
        `  [holders] ${token.symbol}: ${analysis.totalHoldersAnalyzed} active wallets ` +
        `(${analysis.profitPercentage.toFixed(1)}% profit) | ` +
        `realized: ${fmtUsd(agg.netRealized)} | ` +
        `ETA: ${formatEta(pHolders)}`
      );

      status.progress = `${pHolders.completed}/${pHolders.total} | ETA: ${formatEta(pHolders)}`;
      maybeBackup();
    } catch (err) {
      pHolders.errors++;
      console.error(`  [holders] Error analyzing ${token.symbol}:`, err);
    }
  }, CONCURRENCY);

  pHolders.status = "completed";
  pHolders.completedAt = new Date().toISOString();

  // Save the aggregated holders file
  saveJson(runFile("holders"), holderAnalyses);

  if (holderAnalyses.length > 0) {
    const totalHolders = holderAnalyses.reduce((s, h) => s + h.totalHoldersAnalyzed, 0);
    const totalInProfit = holderAnalyses.reduce((s, h) => s + h.holdersInProfit, 0);
    console.log(`\n  RESULT: ${totalHolders} wallets analyzed across ${holderAnalyses.length} tokens`);
    console.log(`  In profit: ${totalInProfit} (${((totalInProfit / totalHolders) * 100).toFixed(1)}%)`);
    console.log(`  In loss: ${totalHolders - totalInProfit} (${(((totalHolders - totalInProfit) / totalHolders) * 100).toFixed(1)}%)`);
  }

  // Backup after Phase 3 completes
  createBackupSnapshot();
  if (runProgress) {
    runProgress.lastBackupAt = new Date().toISOString();
    runProgress.backupCount++;
  }

  // ── Phase 4: Survival Analysis (per-token incremental) ────────────
  runProgress.currentPhase = "survival";
  const pSurvival = runProgress.phases.survival;
  pSurvival.status = "in_progress";
  pSurvival.startedAt = new Date().toISOString();
  pSurvival.total = qualifiedTokens.length;
  status.phase = "Phase 4: Survival Analysis";
  status.progress = `0/${qualifiedTokens.length}`;
  console.log(`\n[Phase 4] Analyzing token survival for ${qualifiedTokens.length} qualified tokens...`);

  // Load already-completed survival analyses
  const survivalCompleted = getCompletedTokens("survival");
  console.log(`  [resume] ${survivalCompleted.size} tokens already analyzed from previous run`);

  const survivals: SurvivalAnalysis[] = [];
  const trajectoryMap = new Map(trajectories.map((t) => [t.tokenAddress, t]));

  // Re-load previously completed analyses
  for (const token of qualifiedTokens) {
    if (survivalCompleted.has(token.address)) {
      const cached = loadTokenResult<SurvivalAnalysis>("survival", token.address);
      if (cached) {
        survivals.push(cached);
        pSurvival.completed++;
      }
    }
  }

  // Analyze remaining tokens (parallel)
  const survivalTodo = qualifiedTokens.filter((t) => {
    if (survivalCompleted.has(t.address)) {
      return !survivals.some((s) => s.tokenAddress === t.address);
    }
    return !!trajectoryMap.get(t.address);
  });
  // Count skipped (no trajectory data)
  const skippedCount = qualifiedTokens.filter((t) =>
    !survivalCompleted.has(t.address) && !trajectoryMap.get(t.address)
  ).length;
  pSurvival.skipped += skippedCount;
  console.log(`  [survival] ${survivalTodo.length} tokens to analyze (${CONCURRENCY} workers)...`);

  await parallelMap(survivalTodo, async (token) => {
    const trajectory = trajectoryMap.get(token.address)!;

    try {
      const itemStart = Date.now();
      console.log(
        `  [survival] (${pSurvival.completed + 1}/${pSurvival.total}) ` +
        `Analyzing ${token.symbol}...`
      );

      const survival = await analyzeSurvival(client, token, trajectory, config);
      saveTokenResult("survival", token.address, survival);
      survivals.push(survival);

      pSurvival.completed++;
      updateEta(pSurvival, Date.now() - itemStart);

      const alive30 = survival.checkpoints.days30?.alive ?? "N/A";
      const alive90 = survival.checkpoints.days90?.alive ?? "N/A";
      const alive365 = survival.checkpoints.days365?.alive ?? "N/A";
      const liqStr = survival.currentLiquidity >= 1e6
        ? `$${(survival.currentLiquidity / 1e6).toFixed(1)}M`
        : `$${(survival.currentLiquidity / 1e3).toFixed(0)}K`;
      console.log(
        `  [survival] ${token.symbol}: liq=${liqStr} 30d=${alive30} 90d=${alive90} 365d=${alive365} | ` +
        `ETA: ${formatEta(pSurvival)}`
      );

      status.progress = `${pSurvival.completed}/${pSurvival.total} | ETA: ${formatEta(pSurvival)}`;
      maybeBackup();
    } catch (err) {
      pSurvival.errors++;
      console.error(`  [survival] Error analyzing ${token.symbol}:`, err);
    }
  }, CONCURRENCY);

  pSurvival.status = "completed";
  pSurvival.completedAt = new Date().toISOString();

  // Save the aggregated survivals file
  saveJson(runFile("survivals"), survivals);

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

  // ── Phase 5: Generate Report ────────────────────────────────────────
  runProgress.currentPhase = "report";
  const pReport = runProgress.phases.report;
  pReport.status = "in_progress";
  pReport.startedAt = new Date().toISOString();
  pReport.total = 1;
  status.phase = "Phase 5: Report Generation";
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

  // Save individual token profile files so /token/:address doesn't load the full 11MB report
  const tokenDir = getFilePath("tokens");
  mkdirSync(tokenDir, { recursive: true });
  for (const td of report.tokenDetails) {
    const profilePath = join(tokenDir, `${td.address}.json`);
    writeFileSync(profilePath, JSON.stringify(td));
  }
  console.log(`  [store] Saved ${report.tokenDetails.length} individual token profiles`);

  // Generate CSV exports for external analysis tools
  const tokensCsv = generateTokensCsv(report);
  writeFileSync(getFilePath("tokens.csv"), tokensCsv);
  console.log(`  [store] Saved tokens.csv (${report.tokenDetails.length} rows, ${(tokensCsv.length / 1024).toFixed(0)} KB)`);

  const walletsCsv = generateWalletsCsv(report);
  writeFileSync(getFilePath("wallets.csv"), walletsCsv);
  const walletRows = walletsCsv.split("\n").length - 1;
  console.log(`  [store] Saved wallets.csv (${walletRows} rows, ${(walletsCsv.length / 1024).toFixed(0)} KB)`);

  pReport.completed = 1;
  pReport.status = "completed";
  pReport.completedAt = new Date().toISOString();

  // Final backup
  createBackupSnapshot();
  if (runProgress) {
    runProgress.lastBackupAt = new Date().toISOString();
    runProgress.backupCount++;
  }

  status.state = "completed";
  status.phase = "done";
  status.lastRun = new Date().toISOString();
  // Only hold lightweight version in memory to avoid OOM
  status.report = dashboardReport;
  status.progress = `${qualifiedTrajectories.length} tokens analyzed`;

  console.log("\n" + "=".repeat(70));
  console.log("ANALYSIS COMPLETE");
  console.log(`Total elapsed: ${formatElapsed(runProgress.startedAt)}`);
  console.log(`Backups created: ${runProgress.backupCount}`);
  console.log("=".repeat(70));

  return report;
}

// ─── HTTP Server ────────────────────────────────────────────────────────

function startHealthServer() {
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const server = createServer((req, res) => {
    try {
      if (req.url === "/") {
        const report = status.report
          || loadJson<DashboardReport>("latest-dashboard.json");
        const html = renderDashboard(report, {
          state: status.state,
          phase: status.phase,
          progress: status.progress,
          lastRun: status.lastRun,
          lastError: status.lastError,
        }, runProgress);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // Token profile page: /token/<address>
      if (req.url?.startsWith("/token/")) {
        const address = req.url.slice(7).split("?")[0];
        if (!address) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing token address</h1>");
          return;
        }

        const tokenProfilePath = join(getFilePath("tokens"), `${address}.json`);
        if (existsSync(tokenProfilePath)) {
          const raw = readFileSync(tokenProfilePath, "utf-8");
          const token = JSON.parse(raw) as AggregateReport["tokenDetails"][number];
          const html = renderTokenProfile({
            address: token.address,
            symbol: token.symbol,
            trajectory: token.trajectory,
            holders: token.holders,
            survival: token.survival,
          });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } else {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(`<h1>Token not found</h1><p>Address: ${address}</p><p><a href="/">Back to dashboard</a></p>`);
        }
        return;
      }

      // ── /progress endpoint — live monitoring ──
      if (req.url === "/progress") {
        if (!runProgress) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: status.state,
            phase: status.phase,
            progress: status.progress,
            lastRun: status.lastRun,
            message: "No active run. Use POST /run to start.",
          }, null, 2));
          return;
        }

        // Build a clean progress summary with ETAs
        const phaseSummaries: Record<string, unknown> = {};
        for (const [key, phase] of Object.entries(runProgress.phases)) {
          const elapsed = phase.startedAt ? formatElapsed(phase.startedAt) : null;
          phaseSummaries[key] = {
            name: phase.name,
            status: phase.status,
            progress: `${phase.completed}/${phase.total}`,
            skipped: phase.skipped,
            errors: phase.errors,
            eta: phase.status === "in_progress" ? formatEta(phase) : null,
            elapsed,
            avgSecondsPerItem: phase.avgMsPerItem > 0 ? (phase.avgMsPerItem / 1000).toFixed(1) : null,
          };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          runId: runProgress.runId,
          status: status.state,
          currentPhase: runProgress.currentPhase,
          elapsed: formatElapsed(runProgress.startedAt),
          phases: phaseSummaries,
          totals: {
            tokensDiscovered: runProgress.totalTokensDiscovered,
            weeklyPassed: runProgress.totalWeeklyPassed,
            qualifiedTokens: runProgress.totalQualified,
          },
          backups: {
            count: runProgress.backupCount,
            lastBackupAt: runProgress.lastBackupAt,
          },
        }, null, 2));
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
        const summaryReport = status.report
          || loadJson<DashboardReport>("latest-dashboard.json");
        if (summaryReport) {
          const { tokenDetails, ...summary } = summaryReport;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(summary, null, 2));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No report available yet" }));
        }
        return;
      }

      if (req.url === "/report") {
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

      if (req.url === "/export/tokens.csv") {
        const csvPath = getFilePath("tokens.csv");
        if (existsSync(csvPath)) {
          stat(csvPath).then((s) => {
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": "attachment; filename=solana-tokens.csv",
              "Content-Length": s.size,
            });
            createReadStream(csvPath).pipe(res);
          }).catch(() => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to read CSV file" }));
          });
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No CSV export available yet. Run the analysis first." }));
        }
        return;
      }

      if (req.url === "/export/wallets.csv") {
        const csvPath = getFilePath("wallets.csv");
        if (existsSync(csvPath)) {
          stat(csvPath).then((s) => {
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": "attachment; filename=solana-wallets.csv",
              "Content-Length": s.size,
            });
            createReadStream(csvPath).pipe(res);
          }).catch(() => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to read CSV file" }));
          });
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No CSV export available yet. Run the analysis first." }));
        }
        return;
      }

      if (req.url === "/backups") {
        const backups = listBackups();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ backups }, null, 2));
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
    } catch (err) {
      console.error(`[http] Error handling ${req.url}:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Internal Server Error</h1><pre>${String(err)}</pre>`);
      }
    }
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
    console.log(`  GET  /                    — dashboard`);
    console.log(`  GET  /progress            — live progress tracking (JSON)`);
    console.log(`  GET  /health              — service status`);
    console.log(`  GET  /backups             — list backup snapshots`);
    console.log(`  GET  /report              — latest analysis report (JSON)`);
    console.log(`  GET  /report/summary      — summary without token details`);
    console.log(`  GET  /export/tokens.csv   — token-level CSV export`);
    console.log(`  GET  /export/wallets.csv  — wallet-level CSV export`);
    console.log(`  POST /run                 — trigger a new analysis run`);
    console.log(`  POST /clear-cache         — clear all cached data`);
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

// ─── Helpers ────────────────────────────────────────────────────────────

function formatMcap(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  startHealthServer();

  try {
    await runAnalysis();
  } catch (err) {
    status.state = "error";
    status.lastError = String(err);
    console.error("Initial analysis failed:", err);
  }

  if (process.env.CRON_INTERVAL_HOURS) {
    scheduleCron();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
