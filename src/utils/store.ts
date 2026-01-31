/**
 * Persistent data store — saves intermediate results to disk so that
 * a long-running analysis can resume after crashes or restarts.
 *
 * On Railway, uses /data (a persistent volume mount) if available,
 * otherwise falls back to ./data in the working directory.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.DATA_DIR || (existsSync("/data") ? "/data" : "./data");

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
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    unlinkSync(join(DATA_DIR, f));
  }
  console.log(`  [store] Cleared ${files.length} cached files`);
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
