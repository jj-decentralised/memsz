/**
 * Standalone script: Analyze holder P&L for top Solana tokens.
 * Usage: CODEX_API_KEY=<key> npx tsx src/scripts/analyze-holders.ts
 */
import "dotenv/config";
import { createCodexClient } from "../client/codex.js";
import { discoverCurrentTokensAboveThreshold } from "../modules/discover-tokens.js";
import { analyzeAllTokenHolders } from "../modules/holder-analysis.js";
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

  // Analyze first 20 tokens for holder data
  const subset = tokens.slice(0, 20);
  console.log(`Analyzing holders for ${subset.length} tokens...\n`);

  const analyses = await analyzeAllTokenHolders(
    client,
    subset.map((t) => ({
      address: t.address,
      symbol: t.symbol,
      networkId: t.networkId,
    })),
    config
  );

  console.log("\nHolder Analysis Summary:");
  for (const a of analyses) {
    console.log(`\n  ${a.symbol}:`);
    console.log(`    Wallets analyzed: ${a.totalHoldersAnalyzed}`);
    console.log(`    In profit: ${a.holdersInProfit} (${a.profitPercentage.toFixed(1)}%)`);
    console.log(`    In loss: ${a.holdersInLoss}`);
    console.log(`    Top 10% avg profit: ${formatUsd(a.top10PercentStats.averageProfit)}`);
    console.log(`    Top 10% max profit: ${formatUsd(a.top10PercentStats.maxProfit)}`);
  }
}

main().catch(console.error);
