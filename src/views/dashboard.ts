import type { AggregateReport, DashboardReport } from "../types/index.js";

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

interface StatusInfo {
  state: string;
  phase: string;
  progress: string;
  lastRun: string | null;
  lastError: string | null;
}

export function renderDashboard(
  report: AggregateReport | DashboardReport | null,
  status: StatusInfo
): string {
  const s = report?.summary;
  const h = report?.holderSummary;
  const sv = report?.survivalRates;

  // All qualified tokens sorted by peak market cap
  const allTokens = report?.tokenDetails
    ?.filter((t) => t.trajectory?.reachedThreshold)
    .sort((a, b) => (b.trajectory?.peakMarketCap ?? 0) - (a.trajectory?.peakMarketCap ?? 0))
    ?? [];

  // Survival funnel data
  const funnelData = sv
    ? [
        { label: "Reached $10M", count: s?.tokensReached10M ?? 0, pct: 100 },
        {
          label: "Alive at 30 days",
          count: sv.days30.alive,
          pct: sv.days30.rate,
        },
        {
          label: "Alive at 90 days",
          count: sv.days90.alive,
          pct: sv.days90.rate,
        },
        {
          label: "Alive at 365 days",
          count: sv.days365.alive,
          pct: sv.days365.rate,
        },
      ]
    : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solana Token Ecosystem Analysis</title>
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
      --accent-green: #14713a;
      --accent-amber: #b8860b;
      --font-serif: "Tiempos Headline", "Georgia", "Times New Roman", serif;
      --font-sans: "Retina", -apple-system, "Segoe UI", "Helvetica Neue", sans-serif;
      --font-mono: "Retina Mono", "SF Mono", "Consolas", monospace;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .masthead {
      border-bottom: 3px double var(--rule-heavy);
      padding: 24px 0 16px;
      text-align: center;
      margin-bottom: 0;
    }

    .masthead h1 {
      font-family: var(--font-serif);
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--ink);
    }

    .masthead .dateline {
      font-size: 12px;
      color: var(--ink-tertiary);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-top: 6px;
    }

    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 24px;
    }

    .status-bar {
      background: ${report ? (status.state === "completed" ? "#f0f7f0" : "#fff8e1") : "#fff3f0"};
      border-bottom: 1px solid var(--rule);
      padding: 8px 0;
      font-size: 12px;
      color: var(--ink-secondary);
      text-align: center;
    }

    .status-bar strong {
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* ── Headline Numbers ── */
    .headline-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid var(--rule);
      margin: 0;
    }

    .headline-stat {
      padding: 28px 20px;
      text-align: center;
      border-right: 1px solid var(--rule);
    }

    .headline-stat:last-child { border-right: none; }

    .headline-stat .number {
      font-family: var(--font-serif);
      font-size: 42px;
      font-weight: 700;
      line-height: 1.1;
      color: var(--ink);
    }

    .headline-stat .number.accent { color: var(--accent); }
    .headline-stat .number.green { color: var(--accent-green); }

    .headline-stat .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--ink-tertiary);
      margin-top: 6px;
    }

    .headline-stat .sub {
      font-size: 13px;
      color: var(--ink-secondary);
      margin-top: 4px;
    }

    /* ── Section Layout ── */
    .section {
      padding: 32px 0 24px;
      border-bottom: 1px solid var(--rule);
    }

    .section-header {
      font-family: var(--font-serif);
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 4px;
      color: var(--ink);
    }

    .section-deck {
      font-size: 14px;
      color: var(--ink-secondary);
      margin-bottom: 20px;
      max-width: 680px;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
    }

    /* ── Survival Funnel ── */
    .funnel { margin-top: 8px; }

    .funnel-row {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
    }

    .funnel-label {
      width: 150px;
      font-size: 13px;
      color: var(--ink-secondary);
      flex-shrink: 0;
    }

    .funnel-bar-wrap {
      flex: 1;
      background: #eee;
      height: 28px;
      position: relative;
      margin: 0 12px;
    }

    .funnel-bar {
      height: 100%;
      background: var(--ink);
      transition: width 0.6s ease;
    }

    .funnel-bar.dead { background: var(--accent); }

    .funnel-value {
      width: 100px;
      text-align: right;
      font-family: var(--font-mono);
      font-size: 14px;
      flex-shrink: 0;
    }

    /* ── Data Table ── */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .data-table thead th {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--ink-tertiary);
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 2px solid var(--rule-heavy);
      text-align: left;
      white-space: nowrap;
    }

    .data-table thead th.num {
      text-align: right;
    }

    .data-table tbody td {
      padding: 7px 10px;
      border-bottom: 1px solid var(--rule);
      vertical-align: middle;
    }

    .data-table tbody td.num {
      text-align: right;
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .data-table tbody td.symbol {
      font-weight: 700;
      font-size: 13px;
    }

    .data-table tbody tr:hover { background: #f5f5f2; }

    .tag {
      display: inline-block;
      padding: 1px 6px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      border-radius: 2px;
    }

    .tag.alive {
      background: #e8f5e9;
      color: var(--accent-green);
    }

    .tag.dead {
      background: #fce4ec;
      color: var(--accent);
    }

    /* ── Key Stats Boxes ── */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0;
    }

    .stat-box {
      padding: 20px;
      border-right: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }

    .stat-box:nth-child(3n) { border-right: none; }

    .stat-box .val {
      font-family: var(--font-serif);
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
    }

    .stat-box .val.red { color: var(--accent); }
    .stat-box .val.green { color: var(--accent-green); }
    .stat-box .val.amber { color: var(--accent-amber); }

    .stat-box .desc {
      font-size: 12px;
      color: var(--ink-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-top: 4px;
    }

    /* ── P&L Distribution ── */
    .dist-bar-row {
      display: flex;
      height: 32px;
      margin: 12px 0;
      overflow: hidden;
    }

    .dist-segment {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      transition: width 0.6s ease;
      min-width: 0;
    }

    .dist-segment.loss-big { background: #b71c1c; }
    .dist-segment.loss-mod { background: #e57373; }
    .dist-segment.even { background: #bdbdbd; color: var(--ink); }
    .dist-segment.gain-mod { background: #81c784; color: var(--ink); }
    .dist-segment.gain-big { background: #2e7d32; }

    .dist-legend {
      display: flex;
      gap: 16px;
      font-size: 11px;
      color: var(--ink-secondary);
      margin-top: 4px;
    }

    .dist-legend span::before {
      content: "";
      display: inline-block;
      width: 10px;
      height: 10px;
      margin-right: 4px;
      vertical-align: middle;
    }

    .dist-legend .l-lb::before { background: #b71c1c; }
    .dist-legend .l-lm::before { background: #e57373; }
    .dist-legend .l-e::before { background: #bdbdbd; }
    .dist-legend .l-gm::before { background: #81c784; }
    .dist-legend .l-gb::before { background: #2e7d32; }

    .footer {
      padding: 24px 0;
      font-size: 11px;
      color: var(--ink-tertiary);
      text-align: center;
      border-top: 1px solid var(--rule);
      margin-top: 32px;
    }

    .footer a { color: var(--ink-tertiary); }

    .no-data {
      text-align: center;
      padding: 80px 20px;
      color: var(--ink-tertiary);
    }

    .no-data h2 {
      font-family: var(--font-serif);
      font-size: 28px;
      color: var(--ink);
      margin-bottom: 8px;
    }

    @media (max-width: 768px) {
      .headline-grid { grid-template-columns: repeat(2, 1fr); }
      .two-col { grid-template-columns: 1fr; }
      .stat-grid { grid-template-columns: 1fr; }
      .headline-stat .number { font-size: 32px; }
      .funnel-label { width: 100px; font-size: 11px; }
    }
  </style>
</head>
<body>

  <div class="status-bar">
    <div class="container">
      <strong>Status:</strong> ${status.state.toUpperCase()}
      ${status.state === "running" ? ` &mdash; ${status.phase} (${status.progress})` : ""}
      ${status.lastRun ? ` &mdash; Last updated ${fmtDate(status.lastRun)}` : ""}
      ${status.lastError ? ` &mdash; <span style="color:var(--accent)">Error: ${status.lastError.slice(0, 80)}</span>` : ""}
    </div>
  </div>

  <div class="container">
    <div class="masthead">
      <h1>Solana Token Ecosystem Analysis</h1>
      <div class="dateline">
        ${report ? `Data from March 20, 2024 &mdash; ${fmtDate(report.generatedAt)} &bull; Powered by Codex.io` : "Analysis pending"}
      </div>
    </div>

    ${!report ? `
    <div class="no-data">
      <h2>Analysis In Progress</h2>
      <p>The pipeline is currently ${status.phase.toLowerCase()}. Check back shortly.</p>
      <p style="margin-top:12px;font-size:12px;color:var(--ink-tertiary)">
        GET <a href="/health">/health</a> for live status &bull;
        GET <a href="/report/summary">/report/summary</a> for data once ready
      </p>
    </div>
    ` : `

    <!-- ═══ HEADLINE NUMBERS ═══ -->
    <div class="headline-grid">
      <div class="headline-stat">
        <div class="number">${fmtNum(s?.tokensReached10M)}</div>
        <div class="label">Tokens Hit $10M Market Cap</div>
        <div class="sub">of ${fmtNum(s?.totalTokensAnalyzed)} total analyzed</div>
      </div>
      <div class="headline-stat">
        <div class="number green">${fmtNum(s?.tokensCurrentlyAbove10M)}</div>
        <div class="label">Still Above $10M Today</div>
        <div class="sub">${fmtPct(s && s.tokensReached10M > 0 ? (s.tokensCurrentlyAbove10M / s.tokensReached10M) * 100 : 0)} retention rate</div>
      </div>
      <div class="headline-stat">
        <div class="number accent">${fmtPct(h?.overallLossPercentage)}</div>
        <div class="label">Holders In Loss</div>
        <div class="sub">${fmtNum(h?.totalHoldersAnalyzed)} wallets analyzed</div>
      </div>
      <div class="headline-stat">
        <div class="number">${s?.medianDaysAbove10M != null ? Number(s.medianDaysAbove10M).toFixed(0) : "—"}</div>
        <div class="label">Median Days Above $10M</div>
        <div class="sub">avg ${s?.averageDaysAbove10M != null ? Number(s.averageDaysAbove10M).toFixed(1) : "—"} days</div>
      </div>
    </div>

    <!-- ═══ SURVIVAL ANALYSIS ═══ -->
    <div class="section">
      <div class="two-col">
        <div>
          <div class="section-header">Token Survival Rates</div>
          <div class="section-deck">
            How many tokens maintain &gt;$100K in liquidity pool depth after hitting the $10M market cap milestone. Survival is measured at 30, 90, and 365-day checkpoints.
          </div>
          <div class="funnel">
            ${funnelData.map((row) => `
              <div class="funnel-row">
                <div class="funnel-label">${row.label}</div>
                <div class="funnel-bar-wrap">
                  <div class="funnel-bar ${row.pct < 30 ? "dead" : ""}" style="width: ${Math.max(2, row.pct)}%"></div>
                </div>
                <div class="funnel-value">${row.count} (${fmtPct(row.pct)})</div>
              </div>
            `).join("")}
          </div>
        </div>
        <div>
          <div class="section-header">Holder Profit &amp; Loss</div>
          <div class="section-deck">
            Distribution of realized + unrealized returns across all wallet addresses that traded tokens which reached the $10M market cap threshold.
          </div>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="val green">${fmtPct(h?.overallProfitPercentage)}</div>
              <div class="desc">Wallets in Profit</div>
            </div>
            <div class="stat-box">
              <div class="val red">${fmtPct(h?.overallLossPercentage)}</div>
              <div class="desc">Wallets in Loss</div>
            </div>
            <div class="stat-box">
              <div class="val">${fmtUsd(h?.top10PercentMaxProfit)}</div>
              <div class="desc">Top Earner Profit</div>
            </div>
            <div class="stat-box">
              <div class="val amber">${fmtUsd(h?.top10PercentAverageProfit)}</div>
              <div class="desc">Top 10% Avg Profit</div>
            </div>
            <div class="stat-box">
              <div class="val">${fmtUsd(h?.top10PercentMedianProfit)}</div>
              <div class="desc">Top 10% Median Profit</div>
            </div>
            <div class="stat-box">
              <div class="val">${fmtNum(h?.totalHoldersAnalyzed)}</div>
              <div class="desc">Total Wallets Analyzed</div>
            </div>
          </div>

          <!-- Global Aggregate P&L -->
          <div style="margin-top:20px">
            <div style="font-family:var(--font-serif);font-size:16px;font-weight:700;margin-bottom:12px">Aggregate P&L Across All Tokens</div>
            <div class="stat-grid">
              <div class="stat-box">
                <div class="val green">${fmtUsd(h?.globalRealizedProfit)}</div>
                <div class="desc">Total Realized Profit</div>
              </div>
              <div class="stat-box">
                <div class="val red">${fmtUsd(h?.globalRealizedLoss)}</div>
                <div class="desc">Total Realized Loss</div>
              </div>
              <div class="stat-box">
                <div class="val ${Number(h?.globalNetPnl) >= 0 ? "green" : "red"}">${fmtUsd(h?.globalNetPnl)}</div>
                <div class="desc">Net P&L (All Wallets)</div>
              </div>
              <div class="stat-box">
                <div class="val green">${fmtUsd(h?.globalUnrealizedProfit)}</div>
                <div class="desc">Unrealized Profit</div>
              </div>
              <div class="stat-box">
                <div class="val red">${fmtUsd(h?.globalUnrealizedLoss)}</div>
                <div class="desc">Unrealized Loss</div>
              </div>
              <div class="stat-box">
                <div class="val amber">${(() => { const pf = Number(h?.globalProfitFactor); return (isNaN(pf) || !isFinite(pf) || pf >= 999999) ? "∞" : pf.toFixed(2) + "x"; })()}</div>
                <div class="desc">Profit Factor</div>
              </div>
              <div class="stat-box">
                <div class="val">${fmtUsd(h?.globalAvgWin)}</div>
                <div class="desc">Avg Win (per token)</div>
              </div>
              <div class="stat-box">
                <div class="val red">${fmtUsd(h?.globalAvgLoss)}</div>
                <div class="desc">Avg Loss (per token)</div>
              </div>
              <div class="stat-box">
                <div class="val">${fmtUsd(h?.globalMedianPnl)}</div>
                <div class="desc">Median P&L (per token)</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ ALL TOKENS TABLE ═══ -->
    <div class="section" style="padding-bottom:0;border-bottom:none">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px">
        <div>
          <div class="section-header">All ${allTokens.length} Tokens That Reached $10M</div>
          <div class="section-deck" style="margin-bottom:12px">
            Every Solana token that hit $10M market cap since March 2024. Click column headers to sort.
          </div>
        </div>
        <input id="token-search" type="text" placeholder="Search tokens..."
          style="padding:6px 12px;border:1px solid var(--rule);font-size:13px;font-family:var(--font-sans);width:220px;background:var(--bg-card)" />
      </div>
      <div style="overflow-x:auto">
      <table class="data-table" id="token-table">
        <thead>
          <tr>
            <th data-sort="index">#</th>
            <th data-sort="symbol">Token</th>
            <th class="num" data-sort="peakMcap">Peak Mcap</th>
            <th class="num" data-sort="currentMcap">Current Mcap</th>
            <th class="num" data-sort="daysAbove">Days &gt;$10M</th>
            <th class="num" data-sort="profitPct">% in Profit</th>
            <th class="num" data-sort="top10Avg">Top 10% Avg</th>
            <th class="num" data-sort="liq">Current Liq.</th>
            <th class="num" data-sort="surv30">30d</th>
            <th class="num" data-sort="surv90">90d</th>
            <th class="num" data-sort="surv365">365d</th>
            <th data-sort="status">Status</th>
          </tr>
        </thead>
        <tbody>
          ${allTokens.map((t, i) => {
            const prof = t.holders ? t.holders.profitPercentage : -1;
            const top10 = t.holders ? t.holders.top10PercentStats.averageProfit : 0;
            const alive = t.survival?.currentlyAlive ?? false;
            const s30 = t.survival?.checkpoints?.days30;
            const s90 = t.survival?.checkpoints?.days90;
            const s365 = t.survival?.checkpoints?.days365;
            const peakMcap = t.trajectory?.peakMarketCap ?? 0;
            const currentMcap = t.trajectory?.currentMarketCap ?? 0;
            const daysAbove = t.trajectory?.daysAboveThreshold ?? 0;
            const liq = t.survival?.currentLiquidity ?? 0;
            return `
              <tr data-symbol="${t.symbol.toLowerCase()}"
                  data-peak="${peakMcap}" data-current="${currentMcap}"
                  data-days="${daysAbove}" data-prof="${prof}"
                  data-top10="${top10}" data-liq="${liq}"
                  data-s30="${s30 ? (s30.alive ? 1 : 0) : -1}"
                  data-s90="${s90 ? (s90.alive ? 1 : 0) : -1}"
                  data-s365="${s365 ? (s365.alive ? 1 : 0) : -1}"
                  data-alive="${alive ? 1 : 0}">
                <td style="color:var(--ink-tertiary)">${i + 1}</td>
                <td class="symbol"><a href="/token/${t.address}" style="text-decoration:none;color:var(--ink);font-weight:600">${t.symbol}</a></td>
                <td class="num">${fmtUsd(peakMcap)}</td>
                <td class="num">${fmtUsd(currentMcap)}</td>
                <td class="num">${daysAbove}</td>
                <td class="num">${prof >= 0 ? fmtPct(prof) : "—"}</td>
                <td class="num">${t.holders ? fmtUsd(top10) : "—"}</td>
                <td class="num">${fmtUsd(liq)}</td>
                <td class="num">${s30 ? `<span class="tag ${s30.alive ? "alive" : "dead"}">${s30.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-tertiary)">—</span>'}</td>
                <td class="num">${s90 ? `<span class="tag ${s90.alive ? "alive" : "dead"}">${s90.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-tertiary)">—</span>'}</td>
                <td class="num">${s365 ? `<span class="tag ${s365.alive ? "alive" : "dead"}">${s365.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-tertiary)">—</span>'}</td>
                <td><span class="tag ${alive ? "alive" : "dead"}">${alive ? "Active" : "Dead"}</span></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
      </div>
      <div style="text-align:center;padding:16px;font-size:12px;color:var(--ink-tertiary)">
        Showing <span id="visible-count">${allTokens.length}</span> of ${allTokens.length} tokens
      </div>
    </div>

    <script>
    (function() {
      const table = document.getElementById('token-table');
      const tbody = table.querySelector('tbody');
      const search = document.getElementById('token-search');
      const countEl = document.getElementById('visible-count');
      let sortCol = 'peakMcap';
      let sortDir = -1; // -1 = desc

      // Search
      search.addEventListener('input', function() {
        const q = this.value.toLowerCase();
        let visible = 0;
        tbody.querySelectorAll('tr').forEach(function(row) {
          const match = !q || row.getAttribute('data-symbol').includes(q) ||
            row.querySelector('.symbol').textContent.toLowerCase().includes(q);
          row.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        countEl.textContent = visible;
      });

      // Sort
      table.querySelectorAll('th[data-sort]').forEach(function(th) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', function() {
          const col = this.getAttribute('data-sort');
          if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = -1; }

          // Update header indicators
          table.querySelectorAll('th').forEach(function(h) { h.style.fontWeight = '600'; });
          this.style.fontWeight = '900';

          const rows = Array.from(tbody.querySelectorAll('tr'));
          rows.sort(function(a, b) {
            var va, vb;
            if (col === 'symbol') {
              va = a.getAttribute('data-symbol'); vb = b.getAttribute('data-symbol');
              return sortDir * va.localeCompare(vb);
            }
            if (col === 'index') {
              return sortDir * (rows.indexOf(a) - rows.indexOf(b));
            }
            var attrMap = {
              peakMcap: 'data-peak', currentMcap: 'data-current',
              daysAbove: 'data-days', profitPct: 'data-prof',
              top10Avg: 'data-top10', liq: 'data-liq',
              surv30: 'data-s30', surv90: 'data-s90', surv365: 'data-s365',
              status: 'data-alive'
            };
            va = parseFloat(a.getAttribute(attrMap[col]) || '0');
            vb = parseFloat(b.getAttribute(attrMap[col]) || '0');
            return sortDir * (va - vb);
          });
          rows.forEach(function(r) { tbody.appendChild(r); });
        });
      });
    })();
    </script>

    `}
  </div>

  <div class="footer">
    <div class="container">
      Data sourced from <a href="https://codex.io">Codex.io</a> GraphQL API &bull;
      Solana network (ID 1399811149) &bull;
      Historical data available from March 20, 2024 &bull;
      Market cap = current circulating supply &times; historical price (approximation)
      <br>
      <a href="/health">/health</a> &bull;
      <a href="/report/summary">/report/summary</a> &bull;
      <a href="/report">/report (full JSON)</a>
    </div>
  </div>

</body>
</html>`;
}
