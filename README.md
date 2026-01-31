# Solana Token Ecosystem Analysis

Research project analyzing Solana ecosystem tokens using the [Codex.io](https://codex.io) GraphQL API. Designed to deploy on [Railway](https://railway.com) as a long-running service.

## Research Questions

1. **How many tokens hit $10M market cap?** — Discover all Solana tokens that reached $10M market cap at any point since March 2024.
2. **How long do they stay?** — Track market cap trajectories: days above threshold, peak values, and current status.
3. **Holder profit/loss** — What percentage of holders end up in profit vs loss? What do the top 10% earners make?
4. **Token survival** — How many tokens maintain >$100K liquidity at 30, 90, and 365 day checkpoints?

## Architecture

```
src/
├── client/codex.ts              # GraphQL client with retry + rate limiting
├── types/index.ts               # TypeScript type definitions
├── utils/
│   ├── helpers.ts               # Shared utilities
│   └── store.ts                 # Persistent data store (survives restarts)
├── modules/
│   ├── discover-tokens.ts       # Phase 1: Token discovery (full pagination)
│   ├── market-cap-trajectory.ts # Phase 2: Price/mcap history
│   ├── holder-analysis.ts       # Phase 3: Wallet PnL (up to 5000/token)
│   └── survival-analysis.ts     # Phase 4: Liquidity survival
├── report.ts                    # Aggregate report generator
├── index.ts                     # Main orchestrator + HTTP server + cron
└── scripts/                     # Standalone scripts for each phase

Dockerfile                       # Multi-stage Docker build
railway.json                     # Railway deployment config
```

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env and add your Codex.io API key from https://dashboard.codex.io

npm run dev     # Full analysis pipeline
```

Individual phases:
```bash
npm run discover      # Find tokens that hit $10M mcap
npm run trajectory    # Analyze market cap over time
npm run holders       # Analyze holder profit/loss
npm run survival      # Check survival at 30/90/365 days
```

## Deploy to Railway

### 1. Create a Railway project

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
```

### 2. Add environment variables

In the Railway dashboard (or via CLI):

| Variable | Required | Default | Description |
|---|---|---|---|
| `CODEX_API_KEY` | Yes | — | Your Codex.io API key |
| `PORT` | Auto | `3000` | Railway injects this |
| `CRON_INTERVAL_HOURS` | No | `24` | Re-run analysis every N hours |
| `MARKET_CAP_THRESHOLD` | No | `10000000` | Market cap threshold ($10M) |
| `LIQUIDITY_SURVIVAL_THRESHOLD` | No | `100000` | Survival liquidity threshold ($100K) |
| `DATA_DIR` | No | `/data` | Persistent storage path |

### 3. Add a persistent volume

In Railway dashboard: **Service > Volumes > Add Volume**
- Mount path: `/data`
- This stores intermediate results so analysis can resume after restarts.

### 4. Deploy

```bash
railway up
```

Or connect your GitHub repo for automatic deployments on push.

### 5. Endpoints

Once deployed, Railway provides a public URL. The service exposes:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Service status, current phase, progress |
| `/report` | GET | Latest analysis report (JSON) |
| `/run` | POST | Trigger a new analysis run |

## Data Completeness

The pipeline is designed to pull **all** available data:

- **Token discovery**: Full pagination across all Solana tokens >$10M mcap, plus two additional sweeps for historical candidates ($1M–$10M with liquidity, $100K–$1M with high liquidity)
- **Holder analysis**: Up to 5,000 wallets per token (vs 1,000 previously)
- **Retry logic**: Exponential backoff (5 retries) for rate limits, server errors, and network failures
- **Intermediate persistence**: Each phase saves results to disk. If the process restarts, it picks up from the last completed phase (cache is per-day)
- **Progress tracking**: Real-time progress via `/health` endpoint

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
- **Historical supply unavailable** — market cap uses current supply * historical price (approximation)
- **Wallet PnL up to 5000 wallets per token** — covers most active traders but not all holders
- **API rate limits apply** — built-in 250ms delay + exponential backoff retries

## API Pricing

| Plan | Price | Requests/Month |
|---|---|---|
| Free | $0 | 10,000 |
| Growth | $350-$2,500 | 1M-10M |
| Enterprise | Custom | Custom |

A full analysis run across hundreds of tokens requires a Growth plan or higher.
