/**
 * Token Profile Page — WSJ-inspired design
 *
 * Individual page for each token showing market cap chart,
 * holder P&L breakdown, wallet tables, and survival checkpoints.
 * Canvas-rendered market cap chart with $10M threshold line.
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
  if (v == null || isNaN(n)) return "\u2014";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPct(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "\u2014";
  return `${n.toFixed(1)}%`;
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "\u2014";
  return n.toLocaleString("en-US");
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function walletRow(w: HolderPnL, i: number): string {
  const cls = w.totalPnlUsd >= 0 ? "green" : "red";
  return `
    <tr>
      <td style="color:#999;font-size:12px">${i + 1}</td>
      <td style="font-family:var(--mono);font-size:11px"><a href="https://solscan.io/account/${w.walletAddress}" target="_blank" rel="noopener" style="color:var(--ink);text-decoration:none;border-bottom:1px dotted #ccc">${shortAddr(w.walletAddress)}</a></td>
      <td class="num ${cls}">${fmtUsd(w.totalPnlUsd)}</td>
      <td class="num">${fmtUsd(w.realizedPnlUsd)}</td>
      <td class="num">${fmtUsd(w.unrealizedPnlUsd)}</td>
      <td class="num">${fmtUsd(w.costBasisUsd)}</td>
      <td class="num">${fmtUsd(w.amountBoughtUsd)}</td>
      <td class="num">${fmtUsd(w.amountSoldUsd)}</td>
      <td class="num">${fmtNum(w.buyCount)}</td>
      <td class="num">${fmtNum(w.sellCount)}</td>
    </tr>`;
}

export function renderTokenProfile(data: TokenProfileData): string {
  const { trajectory: t, holders: h, survival: s } = data;

  const chartData = t?.dailyMarketCaps ?? [];
  const chartJson = JSON.stringify(
    chartData.map((d) => ({ t: d.timestamp * 1000, v: d.marketCap }))
  );

  const hoursAbove = (t as any)?.hoursAboveThreshold ?? (t?.daysAboveThreshold != null ? t.daysAboveThreshold * 24 : null);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(data.symbol)} \u2014 Solana Token Analysis</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root {
      --serif: 'Playfair Display', Georgia, 'Times New Roman', serif;
      --sans: 'Inter', -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif;
      --mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
      --ink: #111;
      --ink-2: #444;
      --ink-3: #777;
      --ink-4: #aaa;
      --rule: #d4d4d4;
      --bg: #fafaf8;
      --card: #fff;
      --red: #c41200;
      --green: #14713a;
      --amber: #b8860b;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }
    a { color: var(--ink); }
    a:hover { color: var(--red); }

    .back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--ink-3);
      text-decoration: none;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 500;
    }
    .back:hover { color: var(--ink); }

    .masthead {
      border-bottom: 4px double #111;
      padding-bottom: 20px;
      margin: 16px 0 0;
    }
    .masthead h1 {
      font-family: var(--serif);
      font-size: 42px;
      font-weight: 900;
      letter-spacing: -1px;
      line-height: 1;
    }
    .masthead .addr {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--ink-3);
      margin-top: 8px;
      word-break: break-all;
    }
    .masthead .status-line {
      margin-top: 12px;
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: var(--ink-2);
    }
    .masthead .status-line strong { color: var(--ink); }

    /* ── Stats ── */
    .sg { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .sb {
      padding: 20px 16px;
      border-right: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }
    .sb:last-child { border-right: none; }
    .sb .v {
      font-family: var(--serif);
      font-size: 24px;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.5px;
    }
    .sb .v.red { color: var(--red); }
    .sb .v.green { color: var(--green); }
    .sb .v.amber { color: var(--amber); }
    .sb .d {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--ink-3);
      margin-top: 4px;
      font-weight: 500;
    }

    /* ── Sections ── */
    .sec {
      margin: 32px 0;
      padding-top: 24px;
      border-top: 1px solid var(--rule);
    }
    .sec-h {
      font-family: var(--serif);
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.3px;
      margin-bottom: 4px;
    }
    .sec-d {
      font-size: 13px;
      color: var(--ink-2);
      margin-bottom: 16px;
      line-height: 1.6;
    }

    /* ── Chart ── */
    .chart-wrap {
      width: 100%;
      height: 320px;
      background: var(--card);
      border: 1px solid var(--rule);
      position: relative;
      margin-top: 12px;
    }
    .chart-wrap canvas { width: 100% !important; height: 100% !important; }

    /* ── P&L Bar ── */
    .pnl-bar { display: flex; height: 28px; overflow: hidden; margin: 12px 0; }
    .pnl-bar div { display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; min-width: 2px; }

    /* ── Table ── */
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } .sg { grid-template-columns: repeat(2, 1fr); } }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 8px 8px; border-bottom: 2px solid #111; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--ink-3); font-weight: 600; }
    td { padding: 6px 8px; border-bottom: 1px solid #eee; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .green { color: var(--green); }
    .red { color: var(--red); }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tag.alive { background: #111; color: #fff; }
    .tag.dead { background: #eee; color: #888; }

    .footer {
      padding: 28px 0;
      font-size: 11px;
      color: var(--ink-3);
      text-align: center;
      border-top: 1px solid var(--rule);
      margin-top: 32px;
    }
    .footer a { color: var(--ink-3); text-decoration: underline; text-underline-offset: 2px; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back">\u2190 Dashboard</a>

    <div class="masthead">
      <h1>${esc(data.symbol)}</h1>
      <div class="addr">${esc(data.address)}</div>
      <div class="status-line">
        <span>Peak: <strong>${fmtUsd(t?.peakMarketCap)}</strong></span>
        <span>Current: <strong>${fmtUsd(t?.currentMarketCap)}</strong></span>
        <span>Hours &gt;$10M: <strong>${hoursAbove != null ? fmtNum(hoursAbove) : "\u2014"}</strong></span>
        <span>${s ? `<span class="tag ${s.currentlyAlive ? "alive" : "dead"}">${s.currentlyAlive ? "Active" : "Dead"}</span>` : ""}</span>
      </div>
    </div>

    <!-- KEY METRICS -->
    <div class="sg" style="margin-top:24px">
      <div class="sb"><div class="v">${fmtUsd(t?.peakMarketCap)}</div><div class="d">Peak Market Cap</div></div>
      <div class="sb"><div class="v">${fmtUsd(t?.currentMarketCap)}</div><div class="d">Current Market Cap</div></div>
      <div class="sb"><div class="v">${hoursAbove != null ? fmtNum(hoursAbove) : "\u2014"}</div><div class="d">Hours Above $10M</div></div>
      <div class="sb"><div class="v">${t?.daysAboveThreshold != null ? fmtNum(t.daysAboveThreshold) : "\u2014"}</div><div class="d">Days Above $10M</div></div>
      <div class="sb"><div class="v">${fmtUsd(s?.currentLiquidity)}</div><div class="d">Current Liquidity</div></div>
      <div class="sb"><div class="v">${fmtNum(h?.totalHoldersAnalyzed)}</div><div class="d">Wallets Analyzed</div></div>
    </div>

    <!-- MARKET CAP CHART -->
    ${chartData.length > 0 ? `
    <div class="sec" style="border-top:none;margin-top:0;padding-top:24px">
      <div class="sec-h">Market Cap Over Time</div>
      <div class="sec-d">Daily market cap from OHLCV data. Dashed red line = $10M threshold.</div>
      <div class="chart-wrap">
        <canvas id="mcap-chart"></canvas>
      </div>
    </div>
    ` : ""}

    <!-- HOLDER P&L -->
    ${h ? `
    <div class="sec">
      <div class="sec-h">Holder Profit &amp; Loss</div>
      <div class="sec-d">${fmtNum(h.totalHoldersAnalyzed)} active wallets analyzed. Realized + unrealized P&amp;L.</div>

      <div class="sg">
        <div class="sb"><div class="v green">${fmtPct(h.profitPercentage)}</div><div class="d">In Profit</div></div>
        <div class="sb"><div class="v red">${fmtPct(100 - h.profitPercentage - (h.holdersBreakeven / Math.max(1, h.totalHoldersAnalyzed)) * 100)}</div><div class="d">In Loss</div></div>
        <div class="sb"><div class="v">${fmtUsd(h.top10PercentStats.maxProfit)}</div><div class="d">Top Earner</div></div>
        <div class="sb"><div class="v amber">${fmtUsd(h.top10PercentStats.averageProfit)}</div><div class="d">Top 10% Avg</div></div>
      </div>

      <!-- P&L Distribution -->
      <div style="margin-top:24px">
        <div class="sec-h" style="font-size:15px">P&L Distribution</div>
        <div class="pnl-bar">
          ${(() => {
            const total = h.totalHoldersAnalyzed || 1;
            const d = h.pnlDistribution;
            return [
              { pct: (d.bigLoss / total) * 100, color: "#222", label: `Big Loss (${d.bigLoss})` },
              { pct: (d.moderateLoss / total) * 100, color: "#666", label: `Mod Loss (${d.moderateLoss})` },
              { pct: (d.breakeven / total) * 100, color: "#bbb", label: `Even (${d.breakeven})` },
              { pct: (d.moderateGain / total) * 100, color: "#999", label: `Mod Gain (${d.moderateGain})` },
              { pct: (d.bigGain / total) * 100, color: "#444", label: `Big Gain (${d.bigGain})` },
            ].filter((s) => s.pct > 0).map((s) =>
              `<div style="width:${Math.max(s.pct, 1.5)}%;background:${s.color}" title="${s.label}">${s.pct > 8 ? Math.round(s.pct) + "%" : ""}</div>`
            ).join("");
          })()}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:10px;color:var(--ink-3);margin-top:4px">
          <span><span style="display:inline-block;width:8px;height:8px;background:#222"></span> Big Loss (&lt;-$1K)</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#666"></span> Mod Loss</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#bbb"></span> Breakeven</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#999"></span> Mod Gain</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#444"></span> Big Gain (&gt;$10K)</span>
        </div>
      </div>

      <!-- Aggregate P&L -->
      ${h.aggregatePnl ? `
      <div style="margin-top:24px">
        <div class="sec-h" style="font-size:15px">Aggregate P&L</div>
        <div class="sec-d" style="font-size:12px">Sum across all ${fmtNum(h.totalHoldersAnalyzed)} active wallets.</div>
        <div class="sg">
          <div class="sb"><div class="v green">${fmtUsd(h.aggregatePnl.totalRealizedProfit)}</div><div class="d">Realized Profit</div></div>
          <div class="sb"><div class="v red">${fmtUsd(h.aggregatePnl.totalRealizedLoss)}</div><div class="d">Realized Loss</div></div>
          <div class="sb"><div class="v ${h.aggregatePnl.netRealized >= 0 ? "green" : "red"}">${fmtUsd(h.aggregatePnl.netRealized)}</div><div class="d">Net Realized</div></div>
          <div class="sb"><div class="v green">${fmtUsd(h.aggregatePnl.totalUnrealizedProfit)}</div><div class="d">Unrealized Profit</div></div>
          <div class="sb"><div class="v red">${fmtUsd(h.aggregatePnl.totalUnrealizedLoss)}</div><div class="d">Unrealized Loss</div></div>
          <div class="sb"><div class="v ${h.aggregatePnl.netTotal >= 0 ? "green" : "red"}">${fmtUsd(h.aggregatePnl.netTotal)}</div><div class="d">Net Total</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.aggregatePnl.totalVolumeBought)}</div><div class="d">Volume Bought</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.aggregatePnl.totalVolumeSold)}</div><div class="d">Volume Sold</div></div>
        </div>
      </div>
      ` : ""}

      <!-- Econometrics -->
      ${h.econometrics ? `
      <div style="margin-top:24px">
        <div class="sec-h" style="font-size:15px">Econometric Analysis</div>
        <div class="sg">
          <div class="sb"><div class="v green">${fmtUsd(h.econometrics.avgWin)}</div><div class="d">Avg Win</div></div>
          <div class="sb"><div class="v red">${fmtUsd(h.econometrics.avgLoss)}</div><div class="d">Avg Loss</div></div>
          <div class="sb"><div class="v amber">${(() => { const pf = Number(h.econometrics.profitFactor); return (isFinite(pf) && pf > 0 && pf < 999999) ? pf.toFixed(2) + "x" : "\u221E"; })()}</div><div class="d">Profit Factor</div></div>
          <div class="sb"><div class="v">${fmtPct(h.econometrics.winRate)}</div><div class="d">Win Rate</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.econometrics.medianPnl)}</div><div class="d">Median P&L</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.econometrics.percentile75)}</div><div class="d">75th Pctl</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.econometrics.percentile90)}</div><div class="d">90th Pctl</div></div>
          <div class="sb"><div class="v">${fmtUsd(h.econometrics.percentile99)}</div><div class="d">99th Pctl</div></div>
        </div>
      </div>
      ` : ""}
    </div>

    <!-- WALLET TABLES -->
    <div class="sec">
      <div class="two-col">
        <div>
          <div class="sec-h" style="font-size:16px">Top Profit Wallets</div>
          <div style="overflow-x:auto;margin-top:8px">
          <table>
            <thead><tr>
              <th>#</th><th>Wallet</th><th class="num">Total P&L</th><th class="num">Realized</th><th class="num">Unrealized</th>
              <th class="num">Cost</th><th class="num">Bought</th><th class="num">Sold</th><th class="num">Buys</th><th class="num">Sells</th>
            </tr></thead>
            <tbody>${(h.topProfitWallets ?? []).map((w, i) => walletRow(w, i)).join("")}</tbody>
          </table>
          </div>
        </div>
        <div>
          <div class="sec-h" style="font-size:16px">Top Loss Wallets</div>
          <div style="overflow-x:auto;margin-top:8px">
          <table>
            <thead><tr>
              <th>#</th><th>Wallet</th><th class="num">Total P&L</th><th class="num">Realized</th><th class="num">Unrealized</th>
              <th class="num">Cost</th><th class="num">Bought</th><th class="num">Sold</th><th class="num">Buys</th><th class="num">Sells</th>
            </tr></thead>
            <tbody>${(h.topLossWallets ?? []).map((w, i) => walletRow(w, i)).join("")}</tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
    ` : `
    <div class="sec">
      <div class="sec-h">Holder P&L</div>
      <p style="color:var(--ink-3)">No holder data available for this token.</p>
    </div>
    `}

    <!-- SURVIVAL -->
    ${s ? `
    <div class="sec">
      <div class="sec-h">Survival Checkpoints</div>
      <div class="sec-d">Liquidity &gt;$100K at each checkpoint after first reaching $10M market cap.</div>
      <div class="sg">
        <div class="sb"><div class="v">${fmtUsd(s.liquidityAtDiscovery)}</div><div class="d">Liq at Discovery</div></div>
        <div class="sb">
          ${s.checkpoints.days30
            ? `<div class="v ${s.checkpoints.days30.alive ? "green" : "red"}">${s.checkpoints.days30.alive ? "Alive" : "Dead"}</div>
               <div class="d">30d (${fmtUsd(s.checkpoints.days30.liquidity)})</div>`
            : `<div class="v" style="color:var(--ink-4)">\u2014</div><div class="d">30 Days</div>`}
        </div>
        <div class="sb">
          ${s.checkpoints.days90
            ? `<div class="v ${s.checkpoints.days90.alive ? "green" : "red"}">${s.checkpoints.days90.alive ? "Alive" : "Dead"}</div>
               <div class="d">90d (${fmtUsd(s.checkpoints.days90.liquidity)})</div>`
            : `<div class="v" style="color:var(--ink-4)">\u2014</div><div class="d">90 Days</div>`}
        </div>
        <div class="sb">
          ${s.checkpoints.days365
            ? `<div class="v ${s.checkpoints.days365.alive ? "green" : "red"}">${s.checkpoints.days365.alive ? "Alive" : "Dead"}</div>
               <div class="d">365d (${fmtUsd(s.checkpoints.days365.liquidity)})</div>`
            : `<div class="v" style="color:var(--ink-4)">\u2014</div><div class="d">365 Days</div>`}
        </div>
        <div class="sb"><div class="v">${fmtUsd(s.currentLiquidity)}</div><div class="d">Current Liquidity</div></div>
      </div>
    </div>
    ` : ""}

    <div class="footer">
      <a href="/">Back to Dashboard</a> &bull;
      Solana Token Ecosystem Analysis &bull;
      <a href="https://codex.io">Codex.io</a>
    </div>
  </div>

  ${chartData.length > 0 ? `
  <script>
  (function() {
    var data = ${chartJson};
    if (!data.length) return;
    var canvas = document.getElementById('mcap-chart');
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;

    function draw() {
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.scale(dpr, dpr);

      var W = rect.width, H = rect.height;
      var pad = { top: 24, right: 64, bottom: 44, left: 12 };
      var cw = W - pad.left - pad.right;
      var ch = H - pad.top - pad.bottom;

      var values = data.map(function(d) { return d.v; });
      var maxV = Math.max.apply(null, values) * 1.1;
      var minT = data[0].t, maxT = data[data.length - 1].t;

      function x(t) { return pad.left + ((t - minT) / (maxT - minT)) * cw; }
      function y(v) { return pad.top + ch - (v / maxV) * ch; }
      function fmtS(v) {
        if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
        return '$' + v.toFixed(0);
      }

      ctx.clearRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 0.5;
      for (var i = 1; i <= 5; i++) {
        var val = (maxV / 5) * i;
        var yy = y(val);
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(W - pad.right, yy); ctx.stroke();
        ctx.fillStyle = '#999';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(fmtS(val), W - pad.right + 54, yy + 4);
      }

      // $10M threshold
      var threshY = y(10000000);
      if (threshY > pad.top && threshY < H - pad.bottom) {
        ctx.strokeStyle = '#c41200';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(pad.left, threshY); ctx.lineTo(W - pad.right, threshY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#c41200';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('$10M', W - pad.right + 4, threshY + 4);
      }

      // X-axis
      ctx.textAlign = 'center';
      ctx.fillStyle = '#999';
      ctx.font = '11px Inter, sans-serif';
      var xSteps = Math.min(6, data.length);
      for (var i = 0; i <= xSteps; i++) {
        var t = minT + (maxT - minT) * (i / xSteps);
        var d = new Date(t);
        ctx.fillText(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), x(t), H - pad.bottom + 20);
      }

      // Area
      ctx.beginPath();
      ctx.moveTo(x(data[0].t), y(data[0].v));
      for (var i = 1; i < data.length; i++) ctx.lineTo(x(data[i].t), y(data[i].v));
      ctx.lineTo(x(data[data.length - 1].t), y(0));
      ctx.lineTo(x(data[0].t), y(0));
      ctx.closePath();
      ctx.fillStyle = 'rgba(17,17,17,0.04)';
      ctx.fill();

      // Line
      ctx.beginPath();
      ctx.moveTo(x(data[0].t), y(data[0].v));
      for (var i = 1; i < data.length; i++) ctx.lineTo(x(data[i].t), y(data[i].v));
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Peak dot
      var peakIdx = 0;
      for (var i = 1; i < data.length; i++) { if (data[i].v > data[peakIdx].v) peakIdx = i; }
      ctx.beginPath();
      ctx.arc(x(data[peakIdx].t), y(data[peakIdx].v), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#111';
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fmtS(data[peakIdx].v), x(data[peakIdx].t), y(data[peakIdx].v) - 10);
    }

    draw();
    window.addEventListener('resize', draw);
  })();
  </script>
  ` : ""}
</body>
</html>`;
}
