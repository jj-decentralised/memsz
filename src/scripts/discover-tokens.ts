/**
 * Standalone script: Discover Solana tokens that reached $10M market cap.
 * Usage: CODEX_API_KEY=<key> npx tsx src/scripts/discover-tokens.ts
 */
import "dotenv/config";
import { createCodexClient } from "../client/codex.js";
import { discoverAllCandidates } from "../modules/discover-tokens.js";
import type { CodexConfig } from "../types/index.js";

async function main() {
  const config: CodexConfig = {
    apiKey: process.env.CODEX_API_KEY!,
    endpoint: "https://graph.codex.io/graphql",
    solanaNetworkId: 1399811149,
    marketCapThreshold: 10_000_000,
    liquiditySurvivalThreshold: 100_000,
  };

  if (!config.apiKey) {
    console.error("Set CODEX_API_KEY environment variable");
    process.exit(1);
  }

  const client = createCodexClient(config);

  console.log("Discovering all Solana token candidates (3 sweeps: liquidity, holders, marketCap)...");
  const all = await discoverAllCandidates(client, config);
  console.log(`Found ${all.length} candidate tokens`);

  // Print top tokens
  const sorted = all.sort((a, b) => b.marketCapUsd - a.marketCapUsd);

  console.log("\nTop tokens by current market cap:");
  for (const t of sorted.slice(0, 20)) {
    console.log(
      `  ${t.symbol.padEnd(12)} mcap=$${(t.marketCapUsd / 1e6).toFixed(1)}M  price=$${t.priceUsd.toFixed(6)}  pair=${t.primaryPairAddress ?? "none"}`
    );
  }
}

main().catch(console.error);
