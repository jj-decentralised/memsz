/**
 * Persistent data store — saves intermediate results to disk so that
 * a long-running analysis can resume after crashes or restarts.
 *
 * On Railway, uses /data (a persistent volume mount) if available,
 * otherwise falls back to ./data in the working directory.
 *
 * Supports:
 * - Per-token incremental saves (each token result saved individually)
 * - Manifest tracking (which tokens are done per phase)
 * - Periodic backup snapshots
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, copyFileSync, statSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || (existsSync("/data") ? "/data" : "./data");
const BACKUP_DIR = join(DATA_DIR, "backups");

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function filePath(name: string): string {
  ensureDir(DATA_DIR);
  return join(DATA_DIR, name);
}

export function saveJson(name: string, data: unknown): void {
  const p = filePath(name);
  writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`  [store] Saved ${name} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
}

export function loadJson<T>(name: string): T | null {
  const p = filePath(name);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    console.log(`  [store] Loaded ${name} from cache`);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function hasCache(name: string): boolean {
  return existsSync(filePath(name));
}

export function getFilePath(name: string): string {
  return filePath(name);
}

/**
 * Clear all cached data files. Returns the list of deleted files.
 */
export function clearAllCache(): string[] {
  ensureDir(DATA_DIR);
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") || f.endsWith(".csv"));
  for (const f of files) {
    unlinkSync(join(DATA_DIR, f));
  }
  // Also clear incremental directories
  const dirs = readdirSync(DATA_DIR).filter((f) => {
    const full = join(DATA_DIR, f);
    return statSync(full).isDirectory() && f !== "backups" && f !== "tokens";
  });
  for (const d of dirs) {
    const dirPath = join(DATA_DIR, d);
    const dirFiles = readdirSync(dirPath);
    for (const f of dirFiles) {
      unlinkSync(join(dirPath, f));
    }
  }
  console.log(`  [store] Cleared ${files.length} cached files + incremental dirs`);
  return files;
}

/**
 * Run ID based on date — allows one fresh run per day,
 * reusing intermediate results within the same day.
 */
export function todayRunId(): string {
  return new Date().toISOString().split("T")[0];
}

export function runFile(phase: string): string {
  return `${todayRunId()}-${phase}.json`;
}

// ─── Per-token incremental persistence ───────────────────────────────────

/**
 * Get the directory for incremental per-token results for a given phase.
 */
function incrementalDir(phase: string): string {
  const dir = join(DATA_DIR, `${todayRunId()}-${phase}`);
  ensureDir(dir);
  return dir;
}

/**
 * Save a single token's result for a phase.
 */
export function saveTokenResult(phase: string, tokenAddress: string, data: unknown): void {
  const dir = incrementalDir(phase);
  const p = join(dir, `${tokenAddress}.json`);
  writeFileSync(p, JSON.stringify(data));
}

/**
 * Load a single token's result for a phase.
 */
export function loadTokenResult<T>(phase: string, tokenAddress: string): T | null {
  const dir = incrementalDir(phase);
  const p = join(dir, `${tokenAddress}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Get set of token addresses that have been completed for a phase.
 */
export function getCompletedTokens(phase: string): Set<string> {
  const dir = incrementalDir(phase);
  if (!existsSync(dir)) return new Set();
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return new Set(files.map((f) => f.replace(".json", "")));
}

/**
 * Load all completed token results for a phase.
 */
export function loadAllTokenResults<T>(phase: string): T[] {
  const dir = incrementalDir(phase);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results: T[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      results.push(JSON.parse(raw) as T);
    } catch {
      // Skip corrupted files
    }
  }
  return results;
}

/**
 * Save a progress manifest for a phase (tracks overall state).
 */
export function saveManifest(phase: string, manifest: PhaseManifest): void {
  const p = filePath(`${todayRunId()}-${phase}-manifest.json`);
  writeFileSync(p, JSON.stringify(manifest, null, 2));
}

/**
 * Load a progress manifest for a phase.
 */
export function loadManifest(phase: string): PhaseManifest | null {
  const p = filePath(`${todayRunId()}-${phase}-manifest.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PhaseManifest;
  } catch {
    return null;
  }
}

export interface PhaseManifest {
  phase: string;
  totalTokens: number;
  completedTokens: number;
  startedAt: string;
  lastUpdatedAt: string;
  status: "in_progress" | "completed";
}

// ─── Version stamp ───────────────────────────────────────────────────────

const VERSION_STAMP_FILE = ".analysis-version";

/**
 * Load the last-run version stamp from disk.
 */
export function loadVersionStamp(): number | null {
  const p = filePath(VERSION_STAMP_FILE);
  if (!existsSync(p)) return null;
  try {
    return parseInt(readFileSync(p, "utf-8").trim(), 10);
  } catch {
    return null;
  }
}

/**
 * Save the current version stamp to disk.
 */
export function saveVersionStamp(version: number): void {
  const p = filePath(VERSION_STAMP_FILE);
  writeFileSync(p, String(version));
}

// ─── Backup snapshots ────────────────────────────────────────────────────

/**
 * Create a backup snapshot of all current data.
 * Copies key files to a timestamped backup directory.
 */
export function createBackupSnapshot(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(BACKUP_DIR, `snapshot-${timestamp}`);
  ensureDir(snapshotDir);

  const runId = todayRunId();
  const filesToBackup = [
    `${runId}-tokens.json`,
    `${runId}-trajectories.json`,
    `${runId}-holders.json`,
    `${runId}-survivals.json`,
    `${runId}-report.json`,
    "latest-report.json",
    "latest-dashboard.json",
  ];

  let backedUp = 0;
  for (const f of filesToBackup) {
    const src = filePath(f);
    if (existsSync(src)) {
      copyFileSync(src, join(snapshotDir, f));
      backedUp++;
    }
  }

  // Also backup manifests
  const allFiles = existsSync(DATA_DIR) ? readdirSync(DATA_DIR) : [];
  for (const f of allFiles) {
    if (f.includes("-manifest.json")) {
      const src = join(DATA_DIR, f);
      copyFileSync(src, join(snapshotDir, f));
      backedUp++;
    }
  }

  console.log(`  [backup] Created snapshot with ${backedUp} files → ${snapshotDir}`);
  return snapshotDir;
}

/**
 * List all backup snapshots with sizes.
 */
export function listBackups(): Array<{ name: string; createdAt: string; files: number }> {
  ensureDir(BACKUP_DIR);
  const dirs = readdirSync(BACKUP_DIR).filter((d) => d.startsWith("snapshot-"));
  return dirs.map((d) => {
    const dirPath = join(BACKUP_DIR, d);
    const files = readdirSync(dirPath).length;
    const timestamp = d.replace("snapshot-", "").replace(/-/g, (m, i) => {
      // Rough restore of ISO timestamp
      return i < 16 ? (i === 10 ? "T" : [4, 7].includes(i) ? "-" : ":") : m;
    });
    return { name: d, createdAt: timestamp, files };
  }).sort((a, b) => b.name.localeCompare(a.name));
}
