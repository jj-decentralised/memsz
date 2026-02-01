export interface TokenInfo {
  address: string;
  networkId: number;
  name: string;
  symbol: string;
  /** Current total/circulating supply */
  totalSupply: string | null;
  circulatingSupply: string | null;
  /** Current price in USD */
  priceUsd: number;
  /** Estimated current market cap */
  marketCapUsd: number;
  /** Timestamp when first detected hitting $10M */
  firstHit10MTimestamp: number | null;
  /** Pair address for the primary liquidity pool */
  primaryPairAddress: string | null;
}

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketCapTrajectory {
  tokenAddress: string;
  symbol: string;
  /** Did the token ever reach $10M market cap? */
  reachedThreshold: boolean;
  /** First timestamp it crossed $10M */
  firstCrossTimestamp: number | null;
  /** Is it currently above $10M? */
  currentlyAbove: boolean;
  /** Total days spent above $10M */
  daysAboveThreshold: number;
  /** Total hours spent above $10M (from hourly bar analysis) */
  hoursAboveThreshold?: number;
  /** Peak market cap observed */
  peakMarketCap: number;
  /** Peak timestamp */
  peakTimestamp: number | null;
  /** Current market cap */
  currentMarketCap: number;
  /** Daily market cap snapshots */
  dailyMarketCaps: Array<{ timestamp: number; marketCap: number }>;
}

export interface HolderPnL {
  walletAddress: string;
  tokenAddress: string;
  /** Realized profit/loss in USD */
  realizedPnlUsd: number;
  /** Unrealized profit/loss in USD */
  unrealizedPnlUsd: number;
  /** Total (realized + unrealized) */
  totalPnlUsd: number;
  /** Total USD cost to acquire tokens */
  costBasisUsd: number;
  /** Current USD value of holdings */
  holdingValueUsd: number;
  /** Total USD bought in last year */
  amountBoughtUsd: number;
  /** Total USD sold in last year */
  amountSoldUsd: number;
  /** Number of buy transactions */
  buyCount: number;
  /** Number of sell transactions */
  sellCount: number;
  /** Whether this wallet is currently in profit */
  inProfit: boolean;
}

export interface TokenHolderAnalysis {
  tokenAddress: string;
  symbol: string;
  /** Total wallets returned by API (including inactive) */
  totalWalletsFetched: number;
  /** Active wallets with trades or cost basis */
  totalHoldersAnalyzed: number;
  holdersInProfit: number;
  holdersInLoss: number;
  holdersBreakeven: number;
  profitPercentage: number;
  /** Top 10% earners stats */
  top10PercentStats: {
    count: number;
    totalProfit: number;
    averageProfit: number;
    medianProfit: number;
    maxProfit: number;
    minProfitInTopDecile: number;
  };
  /** Aggregate realized/unrealized P&L across all wallets */
  aggregatePnl: {
    totalRealizedProfit: number;
    totalRealizedLoss: number;
    netRealized: number;
    totalUnrealizedProfit: number;
    totalUnrealizedLoss: number;
    netUnrealized: number;
    netTotal: number;
    totalVolumeBought: number;
    totalVolumeSold: number;
  };
  /** Econometric distribution stats */
  econometrics: {
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    winRate: number;
    medianPnl: number;
    percentile25: number;
    percentile75: number;
    percentile90: number;
    percentile99: number;
  };
  /** Distribution of P&L across all holders */
  pnlDistribution: {
    bigLoss: number;      // < -$1,000
    moderateLoss: number;  // -$1,000 to -$100
    breakeven: number;     // -$100 to +$100
    moderateGain: number;  // +$100 to +$10,000
    bigGain: number;       // > +$10,000
  };
  /** Top performing wallets (most profit) */
  topProfitWallets: HolderPnL[];
  /** Worst performing wallets (biggest loss) */
  topLossWallets: HolderPnL[];
}

export interface SurvivalAnalysis {
  tokenAddress: string;
  symbol: string;
  /** Liquidity in USD at discovery (when first hit $10M mcap) */
  liquidityAtDiscovery: number;
  /** Current liquidity */
  currentLiquidity: number;
  /** Liquidity at each checkpoint */
  checkpoints: {
    days30: { liquidity: number; alive: boolean; date: string } | null;
    days90: { liquidity: number; alive: boolean; date: string } | null;
    days365: { liquidity: number; alive: boolean; date: string } | null;
  };
  /** Whether the token is still "alive" (>$100K liquidity) now */
  currentlyAlive: boolean;
}

export interface AggregateReport {
  generatedAt: string;
  dataStartDate: string;
  parameters: {
    marketCapThreshold: number;
    liquiditySurvivalThreshold: number;
    network: string;
  };
  summary: {
    totalTokensAnalyzed: number;
    totalCandidatesScanned: number;
    tokensReached10M: number;
    tokensCurrentlyAbove10M: number;
    averageDaysAbove10M: number;
    medianDaysAbove10M: number;
    averageHoursAbove10M: number;
    medianHoursAbove10M: number;
  };
  holderSummary: {
    totalHoldersAnalyzed: number;
    overallProfitPercentage: number;
    overallLossPercentage: number;
    top10PercentAverageProfit: number;
    top10PercentMedianProfit: number;
    top10PercentMaxProfit: number;
    /** Aggregate P&L across ALL tokens */
    globalRealizedProfit: number;
    globalRealizedLoss: number;
    globalUnrealizedProfit: number;
    globalUnrealizedLoss: number;
    globalNetPnl: number;
    globalProfitFactor: number;
    globalMedianPnl: number;
    globalAvgWin: number;
    globalAvgLoss: number;
  };
  survivalRates: {
    days30: { total: number; alive: number; rate: number };
    days90: { total: number; alive: number; rate: number };
    days365: { total: number; alive: number; rate: number };
  };
  tokenDetails: Array<{
    address: string;
    symbol: string;
    trajectory: MarketCapTrajectory;
    holders: TokenHolderAnalysis | null;
    survival: SurvivalAnalysis;
  }>;
}

/**
 * Lightweight version of AggregateReport for the dashboard.
 * Strips dailyMarketCaps from trajectories to reduce memory (~11MB → ~1MB).
 */
export type DashboardReport = Omit<AggregateReport, "tokenDetails"> & {
  tokenDetails: Array<{
    address: string;
    symbol: string;
    trajectory: Omit<MarketCapTrajectory, "dailyMarketCaps">;
    holders: TokenHolderAnalysis | null;
    survival: SurvivalAnalysis;
  }>;
};

export interface CodexConfig {
  apiKey: string;
  endpoint: string;
  solanaNetworkId: number;
  marketCapThreshold: number;
  liquiditySurvivalThreshold: number;
}
