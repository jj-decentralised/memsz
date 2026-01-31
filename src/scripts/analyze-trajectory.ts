/**
 * Standalone script: Analyze market cap trajectory for discovered tokens.
 * Usage: CODEX_API_KEY=<key> npx tsx src/scripts/analyze-trajectory.ts
 */
import "dotenv/config";
import { createCodexClient } from "../client/codex.js";
import { discoverCurrentTokensAboveThreshold } from "../modules/discover-tokens.js";
import { analyzeAllTrajectories } from "../modules/market-cap-trajectory.js";
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

  console.log("Discovering tokens...");
  const tokens = await discoverCurrentTokensAboveThreshold(client, config);
  console.log(`Analyzing trajectories for ${tokens.length} tokens...\n`);

  const trajectories = await analyzeAllTrajectories(client, tokens.slice(0, 50), config);

  const reached = trajectories.filter((t) => t.reachedThreshold);
  const stillAbove = reached.filter((t) => t.currentlyAbove);

  console.log(`\nSummary:`);
  console.log(`  Tokens that reached $10M: ${reached.length}`);
  console.log(`  Still above $10M: ${stillAbove.length}`);
  console.log(`  Fallen below: ${reached.length - stillAbove.length}`);

  const daysAbove = reached.map((t) => t.daysAboveThreshold);
  console.log(
    `  Avg days above $10M: ${(daysAbove.reduce((s, v) => s + v, 0) / (daysAbove.length || 1)).toFixed(1)}`
  );
}

main().catch(console.error);
