/**
 * Dashboard — WSJ-inspired design
 *
 * Black & white aesthetic with accent red for losses, green for gains.
 * Includes live-updating status bar, SVG charts, and interactive data table.
 */

import type { AggregateReport, DashboardReport } from "../types/index.js";

// ─── Formatters ─────────────────────────────────────────────────────────

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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (v == null || isNaN(n)) return "\u2014";
  return n.toLocaleString("en-US");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Types ──────────────────────────────────────────────────────────────

interface StatusInfo {
  state: string;
  phase: string;
  progress: string;
  lastRun: string | null;
  lastError: string | null;
}

interface PhaseProgress {
  name: string;
  status: string;
  total: number;
  completed: number;
  skipped: number;
  errors: number;
  startedAt: string | null;
  completedAt: string | null;
  avgMsPerItem: number;
  recentDurations: number[];
}

interface RunProgress {
  runId: string;
  startedAt: string;
  currentPhase: string;
  phases: Record<string, PhaseProgress>;
  totalTokensDiscovered: number;
  totalWeeklyPassed: number;
  totalQualified: number;
  lastBackupAt: string | null;
  backupCount: number;
}

// ─── Progress Bar Builder ───────────────────────────────────────────────

function buildProgressSection(rp: RunProgress): string {
  const elapsed = Date.now() - new Date(rp.startedAt).getTime();
  const elapsedStr = elapsed < 60000 ? "<1 min" :
    elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} min` :
    `${Math.floor(elapsed / 3600000)}h ${Math.floor((elapsed % 3600000) / 60000)}m`;

  const phaseOrder = ["discovery", "weeklyScreen", "hourlyAnalysis", "holders", "survival", "report"];
  const phaseLabels: Record<string, string> = {
    discovery: "Discovery",
    weeklyScreen: "Weekly Screen",
    hourlyAnalysis: "Hourly Analysis",
    holders: "Holder P&L",
    survival: "Survival",
    report: "Report",
  };

  let rows = "";
  for (const key of phaseOrder) {
    const p = rp.phases[key];
    if (!p) continue;
    const pct = p.total > 0 ? Math.round((p.completed / p.total) * 100) : (p.status === "completed" ? 100 : 0);
    const remaining = p.total - p.completed - p.skipped - p.errors;
    let eta = "";
    if (p.status === "in_progress" && p.avgMsPerItem > 0 && remaining > 0) {
      const etaMs = remaining * p.avgMsPerItem;
      const etaMin = etaMs / 60000;
      eta = etaMin < 1 ? "&lt;1m" : etaMin < 60 ? `~${Math.ceil(etaMin)}m` : `~${Math.floor(etaMin / 60)}h${Math.ceil(etaMin % 60)}m`;
    }
    const isCurrent = p.status === "in_progress";
    const isDone = p.status === "completed";
    const barColor = isDone ? "#222" : isCurrent ? "#222" : "#ccc";
    const textColor = isDone ? "#222" : isCurrent ? "#222" : "#999";

    rows += `
      <div style="display:grid;grid-template-columns:120px 1fr 80px 60px;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid #eee">
        <div style="font-size:11px;font-weight:${isCurrent ? 700 : 400};color:${textColor};letter-spacing:0.3px;text-transform:uppercase">
          ${isCurrent ? "\u25B6 " : isDone ? "\u2713 " : ""}${phaseLabels[key] ?? key}
        </div>
        <div style="height:6px;background:#eee;position:relative;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${barColor};transition:width 0.8s ease"></div>
        </div>
        <div style="font-size:11px;color:${textColor};text-align:right;font-variant-numeric:tabular-nums">
          ${p.completed}/${p.total}${p.errors > 0 ? ` <span style="color:#c41200">(${p.errors}err)</span>` : ""}
        </div>
        <div style="font-size:10px;color:#999;text-align:right">${eta}</div>
      </div>`;
  }

  return `
    <div style="background:#fff;border:1px solid #d4d4d4;padding:20px 24px;margin:24px 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px">
        <div style="font-family:var(--serif);font-size:16px;font-weight:700;letter-spacing:-0.3px">Pipeline Progress</div>
        <div style="font-size:11px;color:#777">
          Elapsed: ${elapsedStr}
          ${rp.lastBackupAt ? ` &bull; Last backup: ${new Date(rp.lastBackupAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}
          ${rp.backupCount > 0 ? ` (${rp.backupCount} total)` : ""}
        </div>
      </div>
      ${rows}
      <div style="display:flex;gap:24px;margin-top:12px;font-size:11px;color:#777">
        <span>Discovered: <strong style="color:#222">${fmtNum(rp.totalTokensDiscovered)}</strong></span>
        <span>Passed Screen: <strong style="color:#222">${fmtNum(rp.totalWeeklyPassed)}</strong></span>
        <span>Qualified ($10M+): <strong style="color:#222">${fmtNum(rp.totalQualified)}</strong></span>
      </div>
    </div>`;
}

// ─── SVG Chart Builders ─────────────────────────────────────────────────

function buildSurvivalChart(sv: AggregateReport["survivalRates"] | null, totalReached: number): string {
  if (!sv) return "";
  const bars = [
    { label: "Reached $10M", value: totalReached, pct: 100 },
    { label: "Alive 30d", value: sv.days30.alive, pct: sv.days30.rate },
    { label: "Alive 90d", value: sv.days90.alive, pct: sv.days90.rate },
    { label: "Alive 365d", value: sv.days365.alive, pct: sv.days365.rate },
  ];

  const W = 480;
  const H = 160;
  const barH = 28;
  const gap = 12;
  const leftPad = 100;
  const rightPad = 80;
  const barW = W - leftPad - rightPad;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto;font-family:var(--sans)">`;
  bars.forEach((b, i) => {
    const y = i * (barH + gap);
    const w = Math.max(2, (b.pct / 100) * barW);
    const fill = i === 0 ? "#222" : b.pct >= 50 ? "#333" : b.pct >= 20 ? "#666" : "#c41200";
    svg += `
      <text x="${leftPad - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#555">${b.label}</text>
      <rect x="${leftPad}" y="${y}" width="${w}" height="${barH}" fill="${fill}" rx="1"/>
      <text x="${leftPad + w + 8}" y="${y + barH / 2 + 4}" font-size="11" fill="#222" font-weight="600">${b.value}</text>
      <text x="${leftPad + w + 8 + String(b.value).length * 7 + 4}" y="${y + barH / 2 + 4}" font-size="10" fill="#999">(${fmtPct(b.pct)})</text>
    `;
  });
  svg += "</svg>";
  return svg;
}

function buildPnlDistChart(dist: { bigLoss: number; moderateLoss: number; breakeven: number; moderateGain: number; bigGain: number } | undefined, total: number): string {
  if (!dist || total <= 0) return "";
  const segments = [
    { label: "Big Loss", value: dist.bigLoss, color: "#222" },
    { label: "Mod. Loss", value: dist.moderateLoss, color: "#666" },
    { label: "Even", value: dist.breakeven, color: "#bbb" },
    { label: "Mod. Gain", value: dist.moderateGain, color: "#999" },
    { label: "Big Gain", value: dist.bigGain, color: "#444" },
  ];
  const W = 480;
  const barH = 32;
  let x = 0;
  let rects = "";
  let labels = "";
  for (const seg of segments) {
    const w = Math.max(0, (seg.value / total) * W);
    if (w > 0) {
      rects += `<rect x="${x}" y="0" width="${w}" height="${barH}" fill="${seg.color}"/>`;
      if (w > 30) {
        rects += `<text x="${x + w / 2}" y="${barH / 2 + 4}" text-anchor="middle" font-size="10" fill="#fff" font-weight="600">${Math.round((seg.value / total) * 100)}%</text>`;
      }
    }
    x += w;
  }
  // Legend
  let lx = 0;
  for (const seg of segments) {
    labels += `<rect x="${lx}" y="${barH + 8}" width="8" height="8" fill="${seg.color}" rx="1"/>`;
    labels += `<text x="${lx + 12}" y="${barH + 15}" font-size="9" fill="#777">${seg.label} (${seg.value})</text>`;
    lx += 90;
  }
  return `<svg viewBox="0 0 ${W} ${barH + 24}" style="width:100%;max-width:${W}px;height:auto;font-family:var(--sans)">${rects}${labels}</svg>`;
}

// ─── Main Renderer ──────────────────────────────────────────────────────

export function renderDashboard(
  report: AggregateReport | DashboardReport | null,
  status: StatusInfo,
  runProgress?: RunProgress | null,
): string {
  const s = report?.summary;
  const h = report?.holderSummary;
  const sv = report?.survivalRates;

  const allTokens = report?.tokenDetails
    ?.filter((t) => t.trajectory?.reachedThreshold)
    .sort((a, b) => (b.trajectory?.peakMarketCap ?? 0) - (a.trajectory?.peakMarketCap ?? 0))
    ?? [];

  // Compute aggregate P&L distribution from individual token data
  const aggDist = { bigLoss: 0, moderateLoss: 0, breakeven: 0, moderateGain: 0, bigGain: 0 };
  let totalDistWallets = 0;
  for (const t of allTokens) {
    if (t.holders?.pnlDistribution) {
      const d = t.holders.pnlDistribution;
      aggDist.bigLoss += d.bigLoss;
      aggDist.moderateLoss += d.moderateLoss;
      aggDist.breakeven += d.breakeven;
      aggDist.moderateGain += d.moderateGain;
      aggDist.bigGain += d.bigGain;
      totalDistWallets += d.bigLoss + d.moderateLoss + d.breakeven + d.moderateGain + d.bigGain;
    }
  }

  const isRunning = status.state === "running";
  const hasData = !!report;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Solana Token Ecosystem Analysis</title>
  ${isRunning ? '<meta http-equiv="refresh" content="30">' : ""}
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
      --rule-h: #111;
      --bg: #fafaf8;
      --card: #fff;
      --red: #c41200;
      --green: #14713a;
      --amber: #b8860b;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Status Ticker ── */
    .ticker {
      background: #111;
      color: #eee;
      font-size: 12px;
      padding: 8px 0;
      letter-spacing: 0.3px;
      overflow: hidden;
    }
    .ticker .wrap {
      max-width: 1140px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .ticker .label {
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 600;
      font-size: 10px;
      flex-shrink: 0;
    }
    .ticker .detail { color: #bbb; }
    .ticker .pulse {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .ticker .pulse.live { background: #4ade80; animation: pulse 2s infinite; }
    .ticker .pulse.done { background: #4ade80; }
    .ticker .pulse.err { background: #f87171; }
    .ticker .pulse.idle { background: #777; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ── Masthead ── */
    .masthead {
      border-bottom: 4px double #111;
      padding: 32px 0 20px;
      text-align: center;
    }
    .masthead h1 {
      font-family: var(--serif);
      font-size: 38px;
      font-weight: 900;
      letter-spacing: -1px;
      line-height: 1.1;
    }
    .masthead .deck {
      font-size: 13px;
      color: var(--ink-3);
      letter-spacing: 1.5px;
      text-transform: uppercase;
      margin-top: 8px;
    }
    .masthead .rule-thin {
      width: 60px;
      height: 1px;
      background: var(--ink-4);
      margin: 12px auto 0;
    }

    .container {
      max-width: 1140px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* ── Headline Grid ── */
    .headlines {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border-bottom: 1px solid var(--rule);
    }
    .hl {
      padding: 32px 20px 28px;
      text-align: center;
      border-right: 1px solid var(--rule);
    }
    .hl:last-child { border-right: none; }
    .hl .n {
      font-family: var(--serif);
      font-size: 46px;
      font-weight: 900;
      line-height: 1;
      letter-spacing: -1px;
    }
    .hl .n.red { color: var(--red); }
    .hl .n.green { color: var(--green); }
    .hl .l {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--ink-3);
      margin-top: 8px;
      font-weight: 500;
    }
    .hl .sub {
      font-size: 12px;
      color: var(--ink-2);
      margin-top: 4px;
    }

    /* ── Sections ── */
    .sec {
      padding: 36px 0 28px;
      border-bottom: 1px solid var(--rule);
    }
    .sec-h {
      font-family: var(--serif);
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.3px;
      margin-bottom: 4px;
    }
    .sec-d {
      font-size: 13px;
      color: var(--ink-2);
      margin-bottom: 20px;
      max-width: 700px;
      line-height: 1.6;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 48px;
    }

    /* ── Stat Boxes ── */
    .sg {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }
    .sb {
      padding: 18px 16px;
      border-right: 1px solid var(--rule);
      border-bottom: 1px solid var(--rule);
    }
    .sb:nth-child(3n) { border-right: none; }
    .sb .v {
      font-family: var(--serif);
      font-size: 26px;
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

    /* ── Table ── */
    .tbl {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .tbl thead th {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--ink-3);
      font-weight: 600;
      padding: 10px 10px;
      border-bottom: 2px solid var(--rule-h);
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }
    .tbl thead th:hover { color: var(--ink); }
    .tbl thead th.num { text-align: right; }
    .tbl tbody td {
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
      vertical-align: middle;
    }
    .tbl tbody td.num {
      text-align: right;
      font-family: var(--mono);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .tbl tbody td.sym {
      font-weight: 700;
      font-size: 13px;
    }
    .tbl tbody tr:hover { background: #f7f7f5; }
    .tbl tbody tr:nth-child(even) { background: #fcfcfa; }
    .tbl tbody tr:nth-child(even):hover { background: #f7f7f5; }

    .tag {
      display: inline-block;
      padding: 2px 7px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .tag.alive { background: #111; color: #fff; }
    .tag.dead { background: #eee; color: #888; }
    .tag.yes { background: #e8f5e9; color: var(--green); }
    .tag.no { background: #fce4ec; color: var(--red); }

    /* ── Search ── */
    .search-wrap {
      position: relative;
    }
    .search-wrap input {
      padding: 8px 12px 8px 32px;
      border: 1px solid var(--rule);
      font-size: 13px;
      font-family: var(--sans);
      width: 240px;
      background: var(--card);
      outline: none;
      transition: border-color 0.2s;
    }
    .search-wrap input:focus { border-color: #111; }
    .search-wrap svg {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      fill: #999;
    }

    /* ── Footer ── */
    .footer {
      padding: 32px 0;
      font-size: 11px;
      color: var(--ink-3);
      text-align: center;
      border-top: 1px solid var(--rule);
      margin-top: 40px;
      line-height: 1.8;
    }
    .footer a { color: var(--ink-3); text-decoration: underline; text-underline-offset: 2px; }
    .footer a:hover { color: var(--ink); }

    .no-data {
      text-align: center;
      padding: 80px 20px;
    }
    .no-data h2 {
      font-family: var(--serif);
      font-size: 28px;
      margin-bottom: 8px;
    }
    .no-data p { color: var(--ink-3); }

    @media (max-width: 768px) {
      .headlines { grid-template-columns: repeat(2, 1fr); }
      .two-col { grid-template-columns: 1fr; gap: 24px; }
      .sg { grid-template-columns: 1fr 1fr; }
      .hl .n { font-size: 32px; }
      .masthead h1 { font-size: 28px; }
      .search-wrap input { width: 100%; }
    }
  </style>
</head>
<body>

<!-- ═══ STATUS TICKER ═══ -->
<div class="ticker">
  <div class="wrap">
    <div>
      <span class="pulse ${isRunning ? "live" : status.state === "completed" ? "done" : status.state === "error" ? "err" : "idle"}"></span>
      <span class="label">${esc(status.state)}</span>
      ${isRunning ? `<span class="detail">&mdash; ${esc(status.phase)} (${esc(status.progress)})</span>` : ""}
      ${status.lastRun ? `<span class="detail">&mdash; Updated ${fmtDate(status.lastRun)}</span>` : ""}
      ${status.lastError ? `<span style="color:#f87171"> &mdash; ${esc(status.lastError.slice(0, 80))}</span>` : ""}
    </div>
    <div class="detail" style="flex-shrink:0">
      <a href="/progress" style="color:#bbb;text-decoration:underline;text-underline-offset:2px">Live Progress</a>
      &bull; <a href="/export/tokens.csv" style="color:#bbb;text-decoration:underline;text-underline-offset:2px">CSV</a>
      &bull; <a href="/report" style="color:#bbb;text-decoration:underline;text-underline-offset:2px">JSON</a>
    </div>
  </div>
</div>

<div class="container">

  <!-- ═══ MASTHEAD ═══ -->
  <div class="masthead">
    <h1>Solana Token Ecosystem Analysis</h1>
    <div class="deck">
      ${hasData ? `${report!.parameters.analysisWindowDays ? `Last ${report!.parameters.analysisWindowDays} Days` : "March 2024 \u2013 Present"} &bull; ${fmtDate(report!.generatedAt)} &bull; Codex.io` : "Analysis Pending"}
    </div>
    <div class="rule-thin"></div>
  </div>

  ${(isRunning && runProgress) ? buildProgressSection(runProgress) : ""}

  ${!hasData ? `
  <div class="no-data">
    <h2>Analysis In Progress</h2>
    <p>The pipeline is currently running. This page refreshes automatically every 30 seconds.</p>
    <p style="margin-top:16px;font-size:12px;color:var(--ink-4)">
      <a href="/progress">/progress</a> &mdash; detailed phase-by-phase progress (JSON)
    </p>
  </div>
  ` : `

  <!-- ═══ HEADLINES ═══ -->
  <div class="headlines">
    <div class="hl">
      <div class="n">${fmtNum(s?.tokensReached10M)}</div>
      <div class="l">Tokens Hit $10M</div>
      <div class="sub">of ${fmtNum(s?.totalCandidatesScanned)} scanned</div>
    </div>
    <div class="hl">
      <div class="n green">${fmtNum(s?.tokensCurrentlyAbove10M)}</div>
      <div class="l">Still Above $10M</div>
      <div class="sub">${s && s.tokensReached10M > 0 ? fmtPct((s.tokensCurrentlyAbove10M / s.tokensReached10M) * 100) : "\u2014"} retention</div>
    </div>
    <div class="hl">
      <div class="n red">${fmtPct(h?.overallLossPercentage)}</div>
      <div class="l">Wallets In Loss</div>
      <div class="sub">${fmtNum(h?.totalHoldersAnalyzed)} wallets</div>
    </div>
    <div class="hl">
      <div class="n">${s?.medianHoursAbove10M != null ? Number(s.medianHoursAbove10M).toFixed(0) : "\u2014"}</div>
      <div class="l">Median Hours &gt;$10M</div>
      <div class="sub">${s?.averageDaysAbove10M != null ? "Avg " + Number(s.averageDaysAbove10M).toFixed(0) + " days" : "\u2014"}</div>
    </div>
  </div>

  <!-- ═══ SURVIVAL & P&L ═══ -->
  <div class="sec">
    <div class="two-col">
      <div>
        <div class="sec-h">Survival Analysis</div>
        <div class="sec-d">
          Liquidity pool depth &gt;$100K at each checkpoint after first hitting $10M market cap.
          Most tokens that reach $10M lose their liquidity within months.
        </div>
        ${buildSurvivalChart(sv ?? null, s?.tokensReached10M ?? 0)}

        <div style="margin-top:24px">
          <div class="sec-h" style="font-size:15px">P&L Distribution</div>
          <div class="sec-d" style="font-size:12px;margin-bottom:12px">
            How all ${fmtNum(h?.totalHoldersAnalyzed)} wallets are distributed across loss and gain buckets.
          </div>
          ${buildPnlDistChart(totalDistWallets > 0 ? aggDist : undefined, totalDistWallets)}
        </div>
      </div>
      <div>
        <div class="sec-h">Aggregate P&L</div>
        <div class="sec-d">
          Realized P&L covers the last ${report?.parameters.analysisWindowDays && report.parameters.analysisWindowDays <= 30 ? "30 days" : "12 months"} of trading (API limitation).
          Unrealized is current holdings value minus cost basis.
        </div>
        <div class="sg">
          <div class="sb"><div class="v green">${fmtUsd(h?.globalRealizedProfit)}</div><div class="d">Realized Profit</div></div>
          <div class="sb"><div class="v red">${fmtUsd(h?.globalRealizedLoss)}</div><div class="d">Realized Loss</div></div>
          <div class="sb"><div class="v ${Number(h?.globalNetPnl) >= 0 ? "green" : "red"}">${fmtUsd(h?.globalNetPnl)}</div><div class="d">Net P&L</div></div>
          <div class="sb"><div class="v green">${fmtUsd(h?.globalUnrealizedProfit)}</div><div class="d">Unrealized Profit</div></div>
          <div class="sb"><div class="v red">${fmtUsd(h?.globalUnrealizedLoss)}</div><div class="d">Unrealized Loss</div></div>
          <div class="sb"><div class="v amber">${(() => { const pf = Number(h?.globalProfitFactor); return (isNaN(pf) || !isFinite(pf) || pf >= 999999) ? "\u221E" : pf.toFixed(2) + "x"; })()}</div><div class="d">Profit Factor</div></div>
        </div>
        <div style="margin-top:24px">
          <div class="sec-h" style="font-size:15px">Per-Wallet Stats</div>
          <div class="sg">
            <div class="sb"><div class="v green">${fmtPct(h?.overallProfitPercentage)}</div><div class="d">In Profit</div></div>
            <div class="sb"><div class="v red">${fmtPct(h?.overallLossPercentage)}</div><div class="d">In Loss</div></div>
            <div class="sb"><div class="v">${fmtUsd(h?.top10PercentMaxProfit)}</div><div class="d">Top Earner</div></div>
            <div class="sb"><div class="v">${fmtUsd(h?.globalAvgWin)}</div><div class="d">Avg Win</div></div>
            <div class="sb"><div class="v red">${fmtUsd(h?.globalAvgLoss)}</div><div class="d">Avg Loss</div></div>
            <div class="sb"><div class="v">${fmtUsd(h?.globalMedianPnl)}</div><div class="d">Median P&L</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ TOKEN TABLE ═══ -->
  <div class="sec" style="border-bottom:none;padding-bottom:0">
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:16px">
      <div>
        <div class="sec-h">All ${allTokens.length} Tokens That Reached $10M</div>
        <div class="sec-d" style="margin-bottom:0">
          Every Solana token that hit $10M market cap. Click headers to sort. Click symbol for full profile.
        </div>
      </div>
      <div class="search-wrap">
        <svg width="14" height="14" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><line x1="16" y1="16" x2="22" y2="22" stroke="currentColor" stroke-width="2"/></svg>
        <input id="search" type="text" placeholder="Search tokens..." />
      </div>
    </div>
    <div style="overflow-x:auto">
    <table class="tbl" id="tbl">
      <thead>
        <tr>
          <th data-s="i">#</th>
          <th data-s="sym">Token</th>
          <th class="num" data-s="peak">Peak Mcap</th>
          <th class="num" data-s="cur">Current</th>
          <th class="num" data-s="hrs">Hours &gt;$10M</th>
          <th class="num" data-s="days">Days</th>
          <th class="num" data-s="prof">% Profit</th>
          <th class="num" data-s="t10">Top 10% Avg</th>
          <th class="num" data-s="liq">Liquidity</th>
          <th data-s="s30">30d</th>
          <th data-s="s90">90d</th>
          <th data-s="s365">1y</th>
          <th data-s="alive">Status</th>
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
          const hoursAbove = (t.trajectory as any)?.hoursAboveThreshold ?? daysAbove * 24;
          const liq = t.survival?.currentLiquidity ?? 0;
          return `<tr
            data-sym="${esc(t.symbol.toLowerCase())}"
            data-peak="${peakMcap}" data-cur="${currentMcap}"
            data-hrs="${hoursAbove}" data-days="${daysAbove}" data-prof="${prof}"
            data-t10="${top10}" data-liq="${liq}"
            data-s30="${s30 ? (s30.alive ? 1 : 0) : -1}"
            data-s90="${s90 ? (s90.alive ? 1 : 0) : -1}"
            data-s365="${s365 ? (s365.alive ? 1 : 0) : -1}"
            data-alive="${alive ? 1 : 0}">
            <td style="color:var(--ink-3);font-size:12px">${i + 1}</td>
            <td class="sym"><a href="/token/${t.address}" style="color:var(--ink);text-decoration:none;border-bottom:1px solid transparent" onmouseover="this.style.borderColor='#111'" onmouseout="this.style.borderColor='transparent'">${esc(t.symbol)}</a></td>
            <td class="num">${fmtUsd(peakMcap)}</td>
            <td class="num">${fmtUsd(currentMcap)}</td>
            <td class="num">${fmtNum(hoursAbove)}</td>
            <td class="num">${fmtNum(daysAbove)}</td>
            <td class="num">${prof >= 0 ? fmtPct(prof) : "\u2014"}</td>
            <td class="num">${t.holders ? fmtUsd(top10) : "\u2014"}</td>
            <td class="num">${fmtUsd(liq)}</td>
            <td>${s30 ? `<span class="tag ${s30.alive ? "yes" : "no"}">${s30.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-4)">\u2014</span>'}</td>
            <td>${s90 ? `<span class="tag ${s90.alive ? "yes" : "no"}">${s90.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-4)">\u2014</span>'}</td>
            <td>${s365 ? `<span class="tag ${s365.alive ? "yes" : "no"}">${s365.alive ? "Yes" : "No"}</span>` : '<span style="color:var(--ink-4)">\u2014</span>'}</td>
            <td><span class="tag ${alive ? "alive" : "dead"}">${alive ? "Active" : "Dead"}</span></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>
    <div style="text-align:center;padding:16px;font-size:12px;color:var(--ink-3)">
      Showing <span id="cnt">${allTokens.length}</span> of ${allTokens.length} tokens
    </div>
  </div>

  <script>
  (function(){
    var tbl=document.getElementById('tbl');
    if(!tbl)return;
    var tbody=tbl.querySelector('tbody');
    var search=document.getElementById('search');
    var cnt=document.getElementById('cnt');
    var sortCol='peak',sortDir=-1;

    search.addEventListener('input',function(){
      var q=this.value.toLowerCase(),vis=0;
      tbody.querySelectorAll('tr').forEach(function(r){
        var m=!q||r.getAttribute('data-sym').includes(q)||r.querySelector('.sym').textContent.toLowerCase().includes(q);
        r.style.display=m?'':'none';
        if(m)vis++;
      });
      cnt.textContent=vis;
    });

    tbl.querySelectorAll('th[data-s]').forEach(function(th){
      th.addEventListener('click',function(){
        var c=this.getAttribute('data-s');
        if(sortCol===c)sortDir*=-1;else{sortCol=c;sortDir=-1;}
        tbl.querySelectorAll('th').forEach(function(h){h.style.fontWeight='600';});
        this.style.fontWeight='900';
        var rows=Array.from(tbody.querySelectorAll('tr'));
        rows.sort(function(a,b){
          if(c==='sym'){var va=a.getAttribute('data-sym'),vb=b.getAttribute('data-sym');return sortDir*va.localeCompare(vb);}
          if(c==='i')return sortDir*(rows.indexOf(a)-rows.indexOf(b));
          var m={peak:'data-peak',cur:'data-cur',hrs:'data-hrs',days:'data-days',prof:'data-prof',t10:'data-t10',liq:'data-liq',s30:'data-s30',s90:'data-s90',s365:'data-s365',alive:'data-alive'};
          var va=parseFloat(a.getAttribute(m[c])||'0'),vb=parseFloat(b.getAttribute(m[c])||'0');
          return sortDir*(va-vb);
        });
        rows.forEach(function(r){tbody.appendChild(r);});
      });
    });
  })();
  </script>

  `}
</div>

<!-- ═══ FOOTER ═══ -->
<div class="footer">
  <div class="container">
    Data from <a href="https://codex.io">Codex.io</a> GraphQL API &bull;
    Solana Network &bull;
    Historical data from March 20, 2024 &bull;
    Market cap = supply &times; historical price
    <br>
    <a href="/progress">/progress</a> &bull;
    <a href="/health">/health</a> &bull;
    <a href="/backups">/backups</a> &bull;
    <a href="/report/summary">/summary</a> &bull;
    <a href="/report">/report</a> &bull;
    <a href="/export/tokens.csv">tokens.csv</a> &bull;
    <a href="/export/wallets.csv">wallets.csv</a>
  </div>
</div>

</body>
</html>`;
}
