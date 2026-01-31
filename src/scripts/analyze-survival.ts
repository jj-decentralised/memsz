/**
 * Standalone script: Analyze token survival rates at 30/90/365 day checkpoints.
 * Usage: CODEX_API_KEY=<key> npx tsx src/scripts/analyze-survival.ts
 */
import "dotenv/config";
import { createCodexClient } from "../client/codex.js";
import { discoverCurrentTokensAboveThreshold } from "../modules/discover-tokens.js";
import { analyzeAllTrajectories } from "../modules/market-cap-trajectory.js";
import { analyzeAllSurvivals } from "../modules/survival-analysis.js";
import type { CodexConfig } from "../types/index.js";
import { formatUsd } from "../utils/helpers.js";

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

  console.log("Discovering tokens...");
  const tokens = await discoverCurrentTokensAboveThreshold(client, config);

  console.log("Analyzing trajectories...");
  const trajectories = await analyzeAllTrajectories(client, tokens.slice(0, 30), config);

  console.log("Analyzing survival...\n");
  const survivals = await analyzeAllSurvivals(
    client,
    tokens.slice(0, 30),
    trajectories,
    config
  );

  // Aggregate
  const s30 = survivals.filter((s) => s.checkpoints.days30 !== null);
  const s90 = survivals.filter((s) => s.checkpoints.days90 !== null);
  const s365 = survivals.filter((s) => s.checkpoints.days365 !== null);

  console.log("\nSurvival Rates (liquidity > $100K):");
  console.log(`  30 days:  ${s30.filter((s) => s.checkpoints.days30?.alive).length}/${s30.length} tokens`);
  console.log(`  90 days:  ${s90.filter((s) => s.checkpoints.days90?.alive).length}/${s90.length} tokens`);
  console.log(`  365 days: ${s365.filter((s) => s.checkpoints.days365?.alive).length}/${s365.length} tokens`);

  console.log("\nCurrently alive:");
  console.log(`  ${survivals.filter((s) => s.currentlyAlive).length}/${survivals.length} tokens have >$100K liquidity now`);
}

main().catch(console.error);
