/**
 * Convert a Date to a Unix timestamp in seconds.
 */
export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Convert a Unix timestamp in seconds to a Date.
 */
export function fromUnixSeconds(timestamp: number): Date {
  return new Date(timestamp * 1000);
}

/**
 * Get the date N days ago from now.
 */
export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Calculate the median of a number array.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Format USD values for display.
 */
export function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
}

/**
 * Paginate through a Codex.io query that uses offset-based pagination.
 * Exhaustive by default — no arbitrary page caps. Set maxPages to limit.
 */
export async function paginateAll<T>(
  fetchPage: (offset: number) => Promise<{ results: T[]; count: number }>,
  pageSize = 200,
  maxPages = 500
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const { results, count } = await fetchPage(offset);
    all.push(...results);

    console.log(`    [paginate] page ${page + 1}: got ${results.length} items (${all.length}/${count} total)`);

    if (all.length >= count || results.length < pageSize || results.length === 0) {
      break;
    }
    offset += pageSize;
  }

  return all;
}

/**
 * Codex.io bar symbol format: <pairAddress>:<networkId>
 */
export function barSymbol(pairAddress: string, networkId: number): string {
  return `${pairAddress}:${networkId}`;
}

/**
 * Batch an array into chunks of a given size.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * The earliest date for Solana data in Codex.io.
 */
export const SOLANA_DATA_START = new Date("2024-03-20T00:00:00Z");
