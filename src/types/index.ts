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
  /** Distribution of P&L across all holders */
  pnlDistribution: {
    bigLoss: number;      // < -50%
    moderateLoss: number;  // -50% to -10%
    breakeven: number;     // -10% to +10%
    moderateGain: number;  // +10% to +100%
    bigGain: number;       // > +100%
  };
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
    tokensReached10M: number;
    tokensCurrentlyAbove10M: number;
    averageDaysAbove10M: number;
    medianDaysAbove10M: number;
  };
  holderSummary: {
    totalHoldersAnalyzed: number;
    overallProfitPercentage: number;
    overallLossPercentage: number;
    top10PercentAverageProfit: number;
    top10PercentMedianProfit: number;
    top10PercentMaxProfit: number;
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
