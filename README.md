# Solana Token Ecosystem Analysis

Research project analyzing Solana ecosystem tokens using the [Codex.io](https://codex.io) GraphQL API.

## Research Questions

1. **How many tokens hit $10M market cap?** — Discover all Solana tokens that reached $10M market cap at any point since March 2024.
2. **How long do they stay?** — Track market cap trajectories: days above threshold, peak values, and current status.
3. **Holder profit/loss** — What percentage of holders end up in profit vs loss? What do the top 10% earners make?
4. **Token survival** — How many tokens maintain >$100K liquidity at 30, 90, and 365 day checkpoints?

## Architecture

```
src/
├── client/codex.ts              # GraphQL client with rate limiting
├── types/index.ts               # TypeScript type definitions
├── utils/helpers.ts             # Shared utilities
├── modules/
│   ├── discover-tokens.ts       # Phase 1: Token discovery
│   ├── market-cap-trajectory.ts # Phase 2: Price/mcap history
│   ├── holder-analysis.ts       # Phase 3: Wallet PnL analysis
│   └── survival-analysis.ts     # Phase 4: Liquidity survival
├── report.ts                    # Aggregate report generator
├── index.ts                     # Main orchestrator
└── scripts/                     # Standalone scripts for each phase
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your Codex.io API key from https://dashboard.codex.io
```

## Usage

Run the full analysis pipeline:
```bash
npm run dev
```

Or run individual phases:
```bash
npm run discover      # Find tokens that hit $10M mcap
npm run trajectory    # Analyze market cap over time
npm run holders       # Analyze holder profit/loss
npm run survival      # Check survival at 30/90/365 days
```

Reports are saved to `reports/analysis-YYYY-MM-DD.json`.

## API Coverage

| Research Question | Codex.io Endpoint | Coverage |
|---|---|---|
| Tokens that hit $10M mcap | `filterTokens` + `getBars` | Partial — data from March 2024 only |
| Duration above threshold | `getBars` (daily OHLCV) | Good — daily resolution |
| Holder profit/loss | `filterTokenWallets` | Good — realized + unrealized PnL |
| Top 10% earner profits | `filterTokenWallets` (sorted by PnL) | Good |
| Survival (liquidity) | `listPairsWithMetadataForToken` + `getDetailedPairStats` | Good |

## Known Limitations

- **Solana data starts March 20, 2024** — tokens that hit $10M before this date are not captured
- **Historical supply unavailable** — market cap uses current supply × historical price (approximation)
- **Wallet PnL capped at 1000 wallets per token** — via pagination limits on `filterTokenWallets`
- **API rate limits apply** — built-in 200ms delay between queries; adjust for your plan tier

## API Pricing

| Plan | Price | Requests/Month |
|---|---|---|
| Free | $0 | 10,000 |
| Growth | $350-$2,500 | 1M-10M |
| Enterprise | Custom | Custom |

A full analysis run across hundreds of tokens will require a Growth plan or higher.
