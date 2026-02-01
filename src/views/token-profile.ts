/**
 * Token Profile Page
 *
 * Individual page for each token showing:
 * - Market cap trajectory chart
 * - Holder P&L breakdown
 * - Top profit / loss wallets
 * - Survival status
 */

import type {
  MarketCapTrajectory,
  TokenHolderAnalysis,
  SurvivalAnalysis,
  HolderPnL,
} from "../types/index.js";

interface TokenProfileData {
  address: string;
  symbol: string;
  trajectory: MarketCapTrajectory | null;
  holders: TokenHolderAnalysis | null;
  survival: SurvivalAnalysis | null;
}

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function walletRow(w: HolderPnL, i: number): string {
  const cls = w.totalPnlUsd >= 0 ? "green" : "red";
  return `
    <tr>
      <td style="color:var(--ink-tertiary)">${i + 1}</td>
      <td class="mono"><a href="https://solscan.io/account/${w.walletAddress}" target="_blank" rel="noopener">${shortAddr(w.walletAddress)}</a></td>
      <td class="num ${cls}">${fmtUsd(w.totalPnlUsd)}</td>
      <td class="num">${fmtUsd(w.realizedPnlUsd)}</td>
      <td class="num">${fmtUsd(w.unrealizedPnlUsd)}</td>
      <td class="num">${fmtUsd(w.costBasisUsd)}</td>
      <td class="num">${fmtUsd(w.amountBoughtUsd)}</td>
      <td class="num">${fmtUsd(w.amountSoldUsd)}</td>
      <td class="num">${fmtNum(w.buyCount)}</td>
      <td class="num">${fmtNum(w.sellCount)}</td>
    </tr>
  `;
}

export function renderTokenProfile(data: TokenProfileData): string {
  const { trajectory: t, holders: h, survival: s } = data;

  // Prepare chart data (daily market caps)
  const chartData = t?.dailyMarketCaps ?? [];
  const chartJson = JSON.stringify(
    chartData.map((d) => ({ t: d.timestamp * 1000, v: d.marketCap }))
  );

  // P&L distribution data for chart
  const distData = h ? JSON.stringify([
    { label: "Big Loss (<-$1K)", value: h.pnlDistribution.bigLoss, color: "#c41200" },
    { label: "Moderate Loss", value: h.pnlDistribution.moderateLoss, color: "#e8735a" },
    { label: "Breakeven", value: h.pnlDistribution.breakeven, color: "#888" },
    { label: "Moderate Gain", value: h.pnlDistribution.moderateGain, color: "#5ab87a" },
    { label: "Big Gain (>$1K)", value: h.pnlDistribution.bigGain, color: "#14713a" },
  ]) : "[]";

  const totalProfit = h?.topProfitWallets?.reduce((s, w) => s + (w.totalPnlUsd > 0 ? w.totalPnlUsd : 0), 0) ?? 0;
  const totalLoss = h?.topLossWallets?.reduce((s, w) => s + (w.totalPnlUsd < 0 ? w.totalPnlUsd : 0), 0) ?? 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.symbol} — Solana Token Analysis</title>
  <style>
    :root {
      --ink: #121212;
      --ink-secondary: #444;
      --ink-tertiary: #777;
      --rule: #d4d4d4;
      --rule-heavy: #222;
      --bg: #faf9f6;
      --bg-card: #fff;
      --accent: #c41200;
      --green: #14713a;
      --red: #c41200;
      --amber: #b8860b;
      --font-serif: "Georgia", "Times New Roman", serif;
      --font-sans: -apple-system, "Segoe UI", "Helvetica Neue", sans-serif;
      --font-mono: "SF Mono", "Consolas", monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--ink); font-family: var(--font-sans); font-size: 14px; line-height: 1.5; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }
    .back { font-size: 13px; color: var(--ink-tertiary); text-decoration: none; }
    .back:hover { color: var(--ink); }

    .masthead { border-bottom: 3px double var(--rule-heavy); padding-bottom: 16px; margin-bottom: 24px; }
    .masthead h1 { font-family: var(--font-serif); font-size: 36px; font-weight: 700; letter-spacing: -0.5px; }
    .masthead .sub { font-size: 14px; color: var(--ink-secondary); margin-top: 4px; font-family: var(--font-mono); }

    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 20px 0; }
    .stat-box { background: var(--bg-card); border: 1px solid var(--rule); padding: 16px; text-align: center; }
    .stat-box .val { font-size: 22px; font-weight: 700; font-family: var(--font-serif); }
    .stat-box .desc { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-tertiary); margin-top: 4px; }
    .green { color: var(--green); }
    .red { color: var(--red); }
    .amber { color: var(--amber); }

    .section { margin: 32px 0; padding-top: 24px; border-top: 1px solid var(--rule); }
    .section-header { font-family: var(--font-serif); font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .section-deck { font-size: 13px; color: var(--ink-secondary); margin-bottom: 16px; }

    .chart-container { width: 100%; height: 300px; background: var(--bg-card); border: 1px solid var(--rule); position: relative; }
    canvas { width: 100% !important; height: 100% !important; }

    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

    .pnl-bar { display: flex; height: 32px; border-radius: 4px; overflow: hidden; margin: 12px 0; }
    .pnl-bar div { display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; min-width: 2px; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--rule-heavy); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-tertiary); }
    td { padding: 6px 10px; border-bottom: 1px solid var(--rule); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    a { color: var(--ink); }
    a:hover { color: var(--accent); }

    .tag { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .tag.alive { background: #e6f4ea; color: var(--green); }
    .tag.dead { background: #fde8e8; color: var(--red); }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">&larr; Back to Dashboard</a>

    <div class="masthead" style="margin-top:12px">
      <h1>${data.symbol}</h1>
      <div class="sub">${data.address}</div>
    </div>

    <!-- KEY METRICS -->
    <div class="stat-grid">
      <div class="stat-box">
        <div class="val">${fmtUsd(t?.peakMarketCap)}</div>
        <div class="desc">Peak Market Cap</div>
      </div>
      <div class="stat-box">
        <div class="val">${fmtUsd(t?.currentMarketCap)}</div>
        <div class="desc">Current Market Cap</div>
      </div>
      <div class="stat-box">
        <div class="val">${(t as any)?.hoursAboveThreshold ?? (t?.daysAboveThreshold != null ? t.daysAboveThreshold * 24 : "—")}</div>
        <div class="desc">Hours Above $10M</div>
      </div>
      <div class="stat-box">
        <div class="val">${t?.daysAboveThreshold ?? "—"}</div>
        <div class="desc">Days Above $10M</div>
      </div>
      <div class="stat-box">
        <div class="val">${fmtUsd(s?.currentLiquidity)}</div>
        <div class="desc">Current Liquidity</div>
      </div>
      <div class="stat-box">
        <div class="val ${s?.currentlyAlive ? "green" : "red"}">${s?.currentlyAlive ? "Active" : "Dead"}</div>
        <div class="desc">Status (&gt;$100K Liq)</div>
      </div>
      <div class="stat-box">
        <div class="val">${fmtNum(h?.totalHoldersAnalyzed)}</div>
        <div class="desc">Wallets Analyzed</div>
      </div>
    </div>

    <!-- MARKET CAP CHART -->
    ${chartData.length > 0 ? `
    <div class="section" style="border-top:none; margin-top:0">
      <div class="section-header">Market Cap Over Time</div>
      <div class="section-deck">Daily market cap from OHLCV data, using current supply as proxy for historical supply.</div>
      <div class="chart-container">
        <canvas id="mcap-chart"></canvas>
      </div>
    </div>
    ` : ""}

    <!-- HOLDER P&L -->
    ${h ? `
    <div class="section">
      <div class="section-header">Holder Profit &amp; Loss</div>
      <div class="section-deck">${fmtNum(h.totalHoldersAnalyzed)} wallets analyzed. Realized + unrealized P&L based on 1-year trading data.</div>

      <div class="stat-grid">
        <div class="stat-box">
          <div class="val green">${fmtPct(h.profitPercentage)}</div>
          <div class="desc">In Profit</div>
        </div>
        <div class="stat-box">
          <div class="val red">${fmtPct(100 - h.profitPercentage - (h.holdersBreakeven / Math.max(1, h.totalHoldersAnalyzed)) * 100)}</div>
          <div class="desc">In Loss</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.top10PercentStats.maxProfit)}</div>
          <div class="desc">Top Earner</div>
        </div>
        <div class="stat-box">
          <div class="val amber">${fmtUsd(h.top10PercentStats.averageProfit)}</div>
          <div class="desc">Top 10% Avg Profit</div>
        </div>
      </div>

      <!-- P&L Distribution Bar -->
      <div class="section-header" style="font-size:16px; margin-top:24px">P&L Distribution</div>
      <div class="pnl-bar">
        ${(() => {
          const total = h.totalHoldersAnalyzed || 1;
          const d = h.pnlDistribution;
          return [
            { pct: (d.bigLoss / total) * 100, color: "#c41200", label: `Loss >$1K (${d.bigLoss})` },
            { pct: (d.moderateLoss / total) * 100, color: "#e8735a", label: `Loss (${d.moderateLoss})` },
            { pct: (d.breakeven / total) * 100, color: "#999", label: `Even (${d.breakeven})` },
            { pct: (d.moderateGain / total) * 100, color: "#5ab87a", label: `Gain (${d.moderateGain})` },
            { pct: (d.bigGain / total) * 100, color: "#14713a", label: `Gain >$1K (${d.bigGain})` },
          ].filter((s) => s.pct > 0).map((s) =>
            `<div style="width:${Math.max(s.pct, 2)}%;background:${s.color}" title="${s.label}">${s.pct > 8 ? Math.round(s.pct) + "%" : ""}</div>`
          ).join("");
        })()}
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--ink-secondary);margin-top:4px">
        <span><span style="display:inline-block;width:10px;height:10px;background:#c41200;border-radius:2px"></span> Big Loss</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#e8735a;border-radius:2px"></span> Moderate Loss</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#999;border-radius:2px"></span> Breakeven</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#5ab87a;border-radius:2px"></span> Moderate Gain</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#14713a;border-radius:2px"></span> Big Gain</span>
      </div>

      <!-- Aggregate P&L Stats -->
      ${h.aggregatePnl ? `
      <div class="section-header" style="font-size:16px; margin-top:24px">Aggregate P&L</div>
      <div class="section-deck">Realized and unrealized profit/loss summed across all ${fmtNum(h.totalHoldersAnalyzed)} active wallets.</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="val green">${fmtUsd(h.aggregatePnl.totalRealizedProfit)}</div>
          <div class="desc">Total Realized Profit</div>
        </div>
        <div class="stat-box">
          <div class="val red">${fmtUsd(h.aggregatePnl.totalRealizedLoss)}</div>
          <div class="desc">Total Realized Loss</div>
        </div>
        <div class="stat-box">
          <div class="val ${h.aggregatePnl.netRealized >= 0 ? "green" : "red"}">${fmtUsd(h.aggregatePnl.netRealized)}</div>
          <div class="desc">Net Realized</div>
        </div>
        <div class="stat-box">
          <div class="val green">${fmtUsd(h.aggregatePnl.totalUnrealizedProfit)}</div>
          <div class="desc">Unrealized Profit</div>
        </div>
        <div class="stat-box">
          <div class="val red">${fmtUsd(h.aggregatePnl.totalUnrealizedLoss)}</div>
          <div class="desc">Unrealized Loss</div>
        </div>
        <div class="stat-box">
          <div class="val ${h.aggregatePnl.netTotal >= 0 ? "green" : "red"}">${fmtUsd(h.aggregatePnl.netTotal)}</div>
          <div class="desc">Net Total P&L</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.aggregatePnl.totalVolumeBought)}</div>
          <div class="desc">Total Volume Bought</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.aggregatePnl.totalVolumeSold)}</div>
          <div class="desc">Total Volume Sold</div>
        </div>
      </div>
      ` : ""}

      <!-- Econometric Stats -->
      ${h.econometrics ? `
      <div class="section-header" style="font-size:16px; margin-top:24px">Econometric Analysis</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="val green">${fmtUsd(h.econometrics.avgWin)}</div>
          <div class="desc">Average Win</div>
        </div>
        <div class="stat-box">
          <div class="val red">${fmtUsd(h.econometrics.avgLoss)}</div>
          <div class="desc">Average Loss</div>
        </div>
        <div class="stat-box">
          <div class="val amber">${(() => { const pf = Number(h.econometrics.profitFactor); return (isFinite(pf) && pf > 0 && pf < 999999) ? pf.toFixed(2) + "x" : "∞"; })()}</div>
          <div class="desc">Profit Factor</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtPct(h.econometrics.winRate)}</div>
          <div class="desc">Win Rate</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.econometrics.medianPnl)}</div>
          <div class="desc">Median P&L</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.econometrics.percentile25)}</div>
          <div class="desc">25th Percentile</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.econometrics.percentile75)}</div>
          <div class="desc">75th Percentile</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.econometrics.percentile90)}</div>
          <div class="desc">90th Percentile</div>
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(h.econometrics.percentile99)}</div>
          <div class="desc">99th Percentile</div>
        </div>
      </div>
      ` : ""}
    </div>

    <!-- WALLET TABLES -->
    <div class="section">
      <div class="two-col">
        <div>
          <div class="section-header" style="font-size:16px">Top Profit Wallets</div>
          <div class="section-deck">Total profit: ${fmtUsd(totalProfit)}</div>
          <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th class="num">Total P&L</th>
                <th class="num">Realized</th>
                <th class="num">Unrealized</th>
                <th class="num">Cost Basis</th>
                <th class="num">Bought</th>
                <th class="num">Sold</th>
                <th class="num">Buys</th>
                <th class="num">Sells</th>
              </tr>
            </thead>
            <tbody>
              ${(h.topProfitWallets ?? []).map((w, i) => walletRow(w, i)).join("")}
            </tbody>
          </table>
          </div>
        </div>
        <div>
          <div class="section-header" style="font-size:16px">Top Loss Wallets</div>
          <div class="section-deck">Total loss: ${fmtUsd(totalLoss)}</div>
          <div style="overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th class="num">Total P&L</th>
                <th class="num">Realized</th>
                <th class="num">Unrealized</th>
                <th class="num">Cost Basis</th>
                <th class="num">Bought</th>
                <th class="num">Sold</th>
                <th class="num">Buys</th>
                <th class="num">Sells</th>
              </tr>
            </thead>
            <tbody>
              ${(h.topLossWallets ?? []).map((w, i) => walletRow(w, i)).join("")}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
    ` : `
    <div class="section">
      <div class="section-header">Holder P&L</div>
      <p style="color:var(--ink-tertiary)">No holder data available for this token.</p>
    </div>
    `}

    <!-- SURVIVAL -->
    ${s ? `
    <div class="section">
      <div class="section-header">Survival Checkpoints</div>
      <div class="section-deck">Liquidity &gt;$100K at each checkpoint after first reaching $10M market cap.</div>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="val">${fmtUsd(s.liquidityAtDiscovery)}</div>
          <div class="desc">Liquidity at Discovery</div>
        </div>
        <div class="stat-box">
          ${s.checkpoints.days30
            ? `<div class="val ${s.checkpoints.days30.alive ? "green" : "red"}">${s.checkpoints.days30.alive ? "Alive" : "Dead"}</div>
               <div class="desc">30 Days (${fmtUsd(s.checkpoints.days30.liquidity)})</div>`
            : `<div class="val" style="color:var(--ink-tertiary)">—</div><div class="desc">30 Days</div>`}
        </div>
        <div class="stat-box">
          ${s.checkpoints.days90
            ? `<div class="val ${s.checkpoints.days90.alive ? "green" : "red"}">${s.checkpoints.days90.alive ? "Alive" : "Dead"}</div>
               <div class="desc">90 Days (${fmtUsd(s.checkpoints.days90.liquidity)})</div>`
            : `<div class="val" style="color:var(--ink-tertiary)">—</div><div class="desc">90 Days</div>`}
        </div>
        <div class="stat-box">
          ${s.checkpoints.days365
            ? `<div class="val ${s.checkpoints.days365.alive ? "green" : "red"}">${s.checkpoints.days365.alive ? "Alive" : "Dead"}</div>
               <div class="desc">365 Days (${fmtUsd(s.checkpoints.days365.liquidity)})</div>`
            : `<div class="val" style="color:var(--ink-tertiary)">—</div><div class="desc">365 Days</div>`}
        </div>
        <div class="stat-box">
          <div class="val">${fmtUsd(s.currentLiquidity)}</div>
          <div class="desc">Current Liquidity</div>
        </div>
      </div>
    </div>
    ` : ""}

    <div style="text-align:center;padding:24px;font-size:11px;color:var(--ink-tertiary);border-top:1px solid var(--rule)">
      Solana Token Ecosystem Analysis &bull; Powered by Codex.io &bull; Data from March 20, 2024
    </div>
  </div>

  ${chartData.length > 0 ? `
  <script>
  (function() {
    const data = ${chartJson};
    if (!data.length) return;

    const canvas = document.getElementById('mcap-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    function draw() {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.scale(dpr, dpr);

      const W = rect.width;
      const H = rect.height;
      const pad = { top: 20, right: 60, bottom: 40, left: 10 };
      const cw = W - pad.left - pad.right;
      const ch = H - pad.top - pad.bottom;

      const values = data.map(d => d.v);
      const minV = 0;
      const maxV = Math.max(...values) * 1.1;
      const minT = data[0].t;
      const maxT = data[data.length - 1].t;

      function x(t) { return pad.left + ((t - minT) / (maxT - minT)) * cw; }
      function y(v) { return pad.top + ch - ((v - minV) / (maxV - minV)) * ch; }

      ctx.clearRect(0, 0, W, H);

      // $10M threshold line
      const threshY = y(10_000_000);
      if (threshY > pad.top && threshY < H - pad.bottom) {
        ctx.strokeStyle = '#c41200';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, threshY);
        ctx.lineTo(W - pad.right, threshY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#c41200';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('$10M', W - pad.right + 4, threshY + 4);
      }

      // Y-axis labels
      ctx.fillStyle = '#777';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      const ySteps = 5;
      for (let i = 0; i <= ySteps; i++) {
        const val = minV + (maxV - minV) * (i / ySteps);
        const yy = y(val);
        ctx.fillText(fmtShort(val), W - pad.right + 50, yy + 4);
        if (i > 0) {
          ctx.strokeStyle = '#eee';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(pad.left, yy);
          ctx.lineTo(W - pad.right, yy);
          ctx.stroke();
        }
      }

      // X-axis labels
      ctx.textAlign = 'center';
      ctx.fillStyle = '#777';
      const xSteps = Math.min(6, data.length);
      for (let i = 0; i <= xSteps; i++) {
        const t = minT + (maxT - minT) * (i / xSteps);
        const d = new Date(t);
        ctx.fillText(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), x(t), H - pad.bottom + 20);
      }

      // Area fill
      ctx.beginPath();
      ctx.moveTo(x(data[0].t), y(data[0].v));
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(x(data[i].t), y(data[i].v));
      }
      ctx.lineTo(x(data[data.length - 1].t), y(0));
      ctx.lineTo(x(data[0].t), y(0));
      ctx.closePath();
      ctx.fillStyle = 'rgba(20, 113, 58, 0.08)';
      ctx.fill();

      // Line
      ctx.beginPath();
      ctx.moveTo(x(data[0].t), y(data[0].v));
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(x(data[i].t), y(data[i].v));
      }
      ctx.strokeStyle = '#14713a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function fmtShort(v) {
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
      return '$' + v.toFixed(0);
    }

    draw();
    window.addEventListener('resize', draw);
  })();
  </script>
  ` : ""}
</body>
</html>`;
}
