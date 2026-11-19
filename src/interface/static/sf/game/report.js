// Mission report: analysis charts on the debrief screen, and downloads a student can keep.
//   PDF  — summary, ascent / aerodynamic / launch-window / conjunction charts, tables, the models used
//   CSV  — flight telemetry (every 0.5 s of flight), conjunctions screened, launch-window scan
//   JSON — everything above in one file
// The PDF is built in the browser with jsPDF (loaded on first use); nothing is uploaded.

const THEMES = {
  dark: { bg: '#0a0d14', grid: 'rgba(150,170,200,.12)', axis: '#8696ad', text: '#e8edf5', title: '#ffffff' },
  light: { bg: '#ffffff', grid: 'rgba(20,30,50,.10)', axis: '#5b6577', text: '#1a2130', title: '#0b0f17' },
};
export const C = { red: '#ff3b4e', amber: '#ffb547', green: '#3ee38c', cyan: '#38e1ff', violet: '#a78bfa', white: '#e8edf5' };

const nice = (lo, hi, n = 5) => {
  const span = hi - lo || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || mag * 10;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
};
const fmtTick = (v) => (Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(0) : String(+v.toPrecision(3)));

/** Line / bar / scatter chart on a canvas. Two optional y axes.
 *  spec: { title, x: {label, min?, max?}, yl: {label, log?}, yr?: {label}, series: [{name, color, axis:'l'|'r', data:[[x,y]], kind:'line'|'bar'|'dots', w?}],
 *          vlines?: [{x, color, label}], hlines?: [{y, color, label}] } */
export function chart(cv, spec, { theme = 'dark', w, h, dpr = devicePixelRatio || 1 } = {}) {
  const T = THEMES[theme];
  const W = (w || cv.clientWidth || 360) * dpr, H = (h || cv.clientHeight || 200) * dpr;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
  const fs = 11 * dpr;
  const L = 46 * dpr, R = (spec.yr ? 46 : 14) * dpr, Tp = 42 * dpr, B = 32 * dpr;
  const pw = W - L - R, ph = H - Tp - B;
  const all = spec.series.flatMap((s) => s.data);
  if (!all.length) { g.fillStyle = T.axis; g.font = `${fs}px JetBrains Mono, monospace`; g.fillText('no data', L, Tp + ph / 2); return; }
  const xs = all.map((p) => p[0]);
  const x0 = spec.x.min ?? Math.min(...xs), x1 = spec.x.max ?? Math.max(...xs);
  const range = (axis) => {
    const ys = spec.series.filter((s) => (s.axis || 'l') === axis).flatMap((s) => s.data.map((p) => p[1])).filter(Number.isFinite);
    if (!ys.length) return null;
    const conf = axis === 'l' ? spec.yl : spec.yr;
    if (conf.log) { const lo = Math.max(conf.min ?? 1e-12, Math.min(...ys.filter((y) => y > 0))), hi = Math.max(...ys); return { log: true, lo: Math.floor(Math.log10(lo)), hi: Math.ceil(Math.log10(hi)) }; }
    const lo = conf.min ?? Math.min(0, ...ys), hi = conf.max ?? Math.max(...ys);
    const t = nice(lo, hi); return { log: false, lo: t[0], hi: t[t.length - 1], ticks: t };
  };
  const ry = { l: range('l'), r: spec.yr ? range('r') : null };
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * pw;
  const Y = (y, a = 'l') => {
    const r = ry[a]; if (!r) return Tp + ph;
    const v = r.log ? Math.log10(Math.max(y, 10 ** r.lo)) : y;
    return Tp + ph - ((v - r.lo) / (r.hi - r.lo || 1)) * ph;
  };
  g.font = `600 ${12 * dpr}px Space Grotesk, Helvetica, sans-serif`; g.fillStyle = T.title;
  g.fillText(spec.title, L, 17 * dpr);
  // legend
  let lx = W - R; g.font = `${10 * dpr}px JetBrains Mono, monospace`;
  for (const s of [...spec.series].reverse()) {
    const tw = g.measureText(s.name).width; lx -= tw + 22 * dpr;
    g.fillStyle = s.color; g.fillRect(lx, 25 * dpr, 10 * dpr, 4 * dpr); g.fillStyle = T.axis; g.fillText(s.name, lx + 14 * dpr, 30 * dpr);
  }
  // grid + ticks
  g.font = `${fs * 0.92}px JetBrains Mono, monospace`; g.lineWidth = 1;
  const lt = ry.l.log ? Array.from({ length: ry.l.hi - ry.l.lo + 1 }, (_, k) => 10 ** (ry.l.lo + k)) : ry.l.ticks;
  for (const v of lt) {
    const y = Y(v); g.strokeStyle = T.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
    g.fillStyle = T.axis; g.textAlign = 'right'; g.fillText(ry.l.log ? `1e${Math.round(Math.log10(v))}` : fmtTick(v), L - 5 * dpr, y + 4 * dpr);
  }
  if (ry.r) for (const v of ry.r.ticks) { g.fillStyle = T.axis; g.textAlign = 'left'; g.fillText(fmtTick(v), L + pw + 5 * dpr, Y(v, 'r') + 4 * dpr); }
  g.textAlign = 'center';
  for (const v of nice(x0, x1, 6)) { if (v < x0 || v > x1) continue; const x = X(v); g.fillStyle = T.axis; g.fillText(fmtTick(v), x, Tp + ph + 15 * dpr); }
  g.fillText(spec.x.label, L + pw / 2, H - 4 * dpr);
  g.save(); g.translate(11 * dpr, Tp + ph / 2); g.rotate(-Math.PI / 2); g.fillText(spec.yl.label, 0, 0); g.restore();
  if (spec.yr) { g.save(); g.translate(W - 6 * dpr, Tp + ph / 2); g.rotate(Math.PI / 2); g.fillText(spec.yr.label, 0, 0); g.restore(); }
  g.textAlign = 'left';
  for (const hl of spec.hlines || []) {
    const y = Y(hl.y); g.strokeStyle = hl.color; g.setLineDash([5 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = hl.color; g.fillText(hl.label, L + 4 * dpr, y - 4 * dpr);
  }
  (spec.vlines || []).forEach((vl, vi) => {
    const x = X(vl.x); g.strokeStyle = vl.color; g.setLineDash([3 * dpr, 3 * dpr]); g.beginPath(); g.moveTo(x, Tp); g.lineTo(x, Tp + ph); g.stroke(); g.setLineDash([]);
    if (vl.label) { g.fillStyle = vl.color; g.fillText(vl.label, x + 3 * dpr, Tp + (10 + (vi % 3) * 11) * dpr); }
  });
  // series
  g.save(); g.beginPath(); g.rect(L, Tp, pw, ph); g.clip();
  for (const s of spec.series) {
    const a = s.axis || 'l';
    if (s.kind === 'bar') {
      const bw = Math.max(2 * dpr, (pw / Math.max(1, s.data.length)) * 0.72);
      for (const [x, y, col] of s.data) { g.fillStyle = col || s.color; g.fillRect(X(x) - bw / 2, Y(y, a), bw, Tp + ph - Y(y, a)); }
    } else if (s.kind === 'dots') {
      for (const [x, y, col] of s.data) { g.fillStyle = col || s.color; g.beginPath(); g.arc(X(x), Y(y, a), 3.4 * dpr, 0, 7); g.fill(); }
    } else {
      g.strokeStyle = s.color; g.lineWidth = (s.w || 2) * dpr; g.lineJoin = 'round'; g.beginPath();
      s.data.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y, a)) : g.moveTo(X(x), Y(y, a)))); g.stroke();
    }
  }
  g.restore();
  g.strokeStyle = T.axis; g.globalAlpha = 0.4; g.strokeRect(L, Tp, pw, ph); g.globalAlpha = 1;
}

// ── chart specs from a report ───────────────────────────────────────────────
export function specs(R) {
  const tel = R.telemetry.filter((s) => s.t >= 0);
  const asc = tel.filter((s) => s.t <= (R.insertion?.t ?? Infinity) + 30);
  const ev = (R.events || []).filter((e) => ['maxq', 'booster_sep', 'stage_sep', 'fairing', 'seco', 'orbit'].includes(e.key) && e.t <= (R.insertion?.t ?? 1e9) + 30);
  const evLines = ev.map((e) => ({ x: e.t, color: 'rgba(255,59,78,.55)', label: { maxq: 'Max-Q', booster_sep: 'Boosters', stage_sep: 'Staging', fairing: 'Fairing', seco: 'SECO', orbit: 'Orbit' }[e.key] }));
  const out = [
    { id: 'ascent', title: 'Ascent profile', x: { label: 'time since lift-off (s)' }, yl: { label: 'altitude (km)' }, yr: { label: 'speed (km/s)' },
      series: [{ name: 'altitude', color: C.red, data: asc.map((s) => [s.t, s.alt]) }, { name: 'inertial speed', color: C.cyan, axis: 'r', data: asc.map((s) => [s.t, s.speed / 1000]) }], vlines: evLines },
    { id: 'aero', title: 'Air drag and loads', x: { label: 'time since lift-off (s)', max: Math.min(asc.at(-1)?.t || 1, 400) }, yl: { label: 'dynamic pressure q (kPa)' }, yr: { label: 'acceleration (g)' },
      series: [{ name: 'q = ½ρv²', color: C.amber, data: asc.filter((s) => s.t <= 400).map((s) => [s.t, s.q / 1000]) }, { name: 'g-load', color: C.violet, axis: 'r', data: asc.filter((s) => s.t <= 400).map((s) => [s.t, s.g]) }],
      vlines: evLines.filter((v) => v.x <= 400) },
    { id: 'dv', title: 'Where the Δv went', x: { label: '', min: -0.5, max: 4.5 }, yl: { label: 'm/s' },
      series: [{ name: 'Δv (m/s)', color: C.cyan, kind: 'bar', data: [[0, R.losses.ideal, C.cyan], [1, R.losses.gravity, C.red], [2, R.losses.drag, C.amber], [3, R.losses.steering, C.violet], [4, R.losses.ideal - R.losses.gravity - R.losses.drag - R.losses.steering, C.green]] }],
      xticks: ['ideal', 'gravity', 'drag', 'steering', 'gained'] },
  ];
  if (R.window?.length > 1) out.push({ id: 'window', title: 'Launch window: closest approach per lift-off time', x: { label: 'lift-off slip (min)' }, yl: { label: 'closest approach (km)', log: true, min: 0.01 },
    series: [{ name: 'miss distance', color: C.green, kind: 'bar', data: R.window.map((d) => [d.slip / 60, Math.max(0.01, d.minMiss), d.red ? C.red : d.amber ? C.amber : C.green]) }],
    vlines: [{ x: R.slip / 60, color: C.cyan, label: 'chosen' }], hlines: [{ y: 1, color: C.red, label: 'RED < 1 km' }, { y: 5, color: C.amber, label: 'AMBER < 5 km' }] });
  if (R.conjunctions?.length) out.push({ id: 'conj', title: 'Conjunctions screened: miss vs collision probability', x: { label: 'miss distance (km)', min: 0 }, yl: { label: 'Pc', log: true, min: 1e-12 },
    series: [{ name: 'object', color: C.white, kind: 'dots', data: R.conjunctions.slice(0, 200).map((c) => [c.miss, Math.max(1e-12, c.pc), c.risk === 'RED' ? C.red : c.risk === 'AMBER' ? C.amber : C.green]) }],
    hlines: [{ y: 1e-4, color: C.red, label: 'Pc 1e-4 (maneuver)' }, { y: 1e-6, color: C.amber, label: 'Pc 1e-6' }] });
  return out;
}

export function renderAnalysis(host, R) {
  const list = specs(R);
  host.innerHTML = list.map((s) => `<div class="an-card"><canvas data-an="${s.id}"></canvas></div>`).join('');
  for (const s of list) {
    const cv = host.querySelector(`[data-an="${s.id}"]`);
    chart(cv, s, { h: 210 });
    if (s.xticks) labelBars(cv, s, 'dark');
  }
}
function labelBars(cv, s, theme, dpr = devicePixelRatio || 1) {
  // replace numeric x ticks of the Δv chart with category names
  const g = cv.getContext('2d'), T = THEMES[theme], L = 46 * dpr, R = 14 * dpr, pw = cv.width - L - R, H = cv.height;
  g.fillStyle = T.bg; g.fillRect(L, H - 32 * dpr + 4 * dpr, pw, 28 * dpr);
  g.fillStyle = T.axis; g.font = `${10 * dpr}px JetBrains Mono, monospace`; g.textAlign = 'center';
  s.xticks.forEach((t, i) => { g.fillText(t, L + ((i + 0.5) / 5) * pw, H - 14 * dpr); g.fillText(Math.round(s.series[0].data[i][1]).toLocaleString(), L + ((i + 0.5) / 5) * pw, H - 3 * dpr); });
  g.textAlign = 'left';
}

// ── downloads ───────────────────────────────────────────────────────────────
const slug = (R) => `sentinelflight_${(R.mission || 'free-flight').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${R.launchUTC.slice(0, 16).replace(/[:T]/g, '')}`;
function save(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const csv = (rows) => rows.map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '')).join(',')).join('\n');

export function downloadTelemetry(R) {
  const cols = ['t', 'alt', 'speed', 'airspeed', 'vs', 'downrange', 'q', 'mach', 'g', 'throttle', 'mass', 'apo', 'peri', 'inc', 'pitch', 'aoa', 'dvLeft', 'stage', 'phase'];
  const head = ['t_s', 'alt_km', 'speed_ms', 'airspeed_ms', 'vert_speed_ms', 'downrange_km', 'q_Pa', 'mach', 'accel_g', 'throttle', 'mass_kg', 'apoapsis_km', 'periapsis_km', 'inc_deg', 'pitch_deg', 'aoa_deg', 'dv_left_ms', 'stage', 'phase'];
  save(slug(R) + '_telemetry.csv', new Blob([csv([head, ...R.telemetry.map((s) => cols.map((k) => (typeof s[k] === 'number' ? +s[k].toPrecision(7) : s[k])))])], { type: 'text/csv' }));
}
export function downloadConjunctions(R) {
  const head = ['risk', 'norad_id', 'name', 'type', 'miss_km', 'radial_km', 'along_km', 'cross_km', 'rel_speed_kms', 'pc', 'tca_utc'];
  save(slug(R) + '_conjunctions.csv', new Blob([csv([head, ...R.conjunctions.map((c) => [c.risk, c.id > 0 ? c.id : 'synthetic', c.name, c.type, c.miss, c.radial, c.along, c.cross, c.relSpeed, c.pc, c.tcaUTC])])
    + '\n\n' + csv([['slip_s', 'closest_km', 'red', 'amber'], ...(R.window || []).map((d) => [d.slip, d.minMiss, d.red ? 1 : 0, d.amber ? 1 : 0])])], { type: 'text/csv' }));
}
export function downloadJSON(R) { save(slug(R) + '.json', new Blob([JSON.stringify(R, null, 1)], { type: 'application/json' })); }

let jsPDFp = null;
function loadJsPDF() {
  if (!jsPDFp) jsPDFp = new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = () => ok(window.jspdf.jsPDF); s.onerror = () => { jsPDFp = null; bad(new Error('could not load the PDF library')); };
    document.head.appendChild(s);
  });
  return jsPDFp;
}
// jsPDF's built-in fonts are WinAnsi: spell out the Greek and math symbols
const A = (t) => String(t).replace(/Δv/g, 'delta-v').replace(/Δ/g, 'delta ').replace(/σ/g, 'sigma').replace(/ρ/g, 'rho').replace(/α/g, 'alpha').replace(/·/g, '·')
  .replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/≈/g, '~').replace(/−/g, '-').replace(/→/g, '->').replace(/×/g, 'x').replace(/½/g, '1/2').replace(/²/g, '^2').replace(/[^\x00-\xff]/g, '');

export async function downloadPDF(R) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 14;
  let y = 0;
  const header = (sub) => {
    doc.setFillColor(11, 15, 23); doc.rect(0, 0, W, 26, 'F');
    doc.setFillColor(255, 59, 78); doc.rect(0, 26, W, 1.4, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.text('SENTINELFLIGHT', M, 12);
    doc.setTextColor(255, 59, 78); doc.setFontSize(9); doc.text('MISSION REPORT', M, 19);
    doc.setTextColor(200, 208, 220); doc.setFont('helvetica', 'normal'); doc.text(A(sub), W - M, 19, { align: 'right' });
    y = 36;
  };
  const footer = () => {
    const n = doc.internal.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120, 128, 140);
      doc.text('sentinelflight.poelys.com · simulation for education: approximate public vehicle data, public TLEs (no covariance).', M, 290);
      doc.text(`${i} / ${n}`, W - M, 290, { align: 'right' });
    }
  };
  const h2 = (t) => { if (y > 262) { doc.addPage(); header(R.mission || 'Free flight'); } doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(11, 15, 23); doc.text(A(t), M, y); doc.setFillColor(255, 59, 78); doc.rect(M, y + 1.6, 12, 0.7, 'F'); y += 7; };
  const kv = (rows, cols = 2) => {
    doc.setFontSize(8.6); const cw = (W - 2 * M) / cols;
    rows.forEach(([k, v], i) => {
      const cx = M + (i % cols) * cw, cy = y + Math.floor(i / cols) * 5.4;
      doc.setFont('helvetica', 'normal'); doc.setTextColor(95, 104, 118); doc.text(A(k), cx, cy);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(20, 26, 38); doc.text(A(v), cx + cw - 3, cy, { align: 'right' });
    });
    y += Math.ceil(rows.length / cols) * 5.4 + 3;
  };
  const para = (t, size = 8.6) => { doc.setFont('helvetica', 'normal'); doc.setFontSize(size); doc.setTextColor(40, 48, 62); const L = doc.splitTextToSize(A(t), W - 2 * M); if (y + L.length * 4 > 282) { doc.addPage(); header(R.mission || 'Free flight'); } doc.text(L, M, y); y += L.length * 3.9 + 2; };
  const img = (spec) => {
    const cv = document.createElement('canvas');
    chart(cv, spec, { theme: 'light', w: 900, h: 330, dpr: 2 });
    if (spec.xticks) labelBars(cv, spec, 'light', 2);
    const hmm = (W - 2 * M) * 330 / 900;
    if (y + hmm > 282) { doc.addPage(); header(R.mission || 'Free flight'); }
    doc.addImage(cv.toDataURL('image/png'), 'PNG', M, y, W - 2 * M, hmm); y += hmm + 4;
  };

  header(R.mission || 'Free flight');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(11, 15, 23);
  doc.text(A(R.verdict), M, y + 2);
  doc.setTextColor(255, 59, 78); doc.setFontSize(14); doc.text('*'.repeat(R.stars) + '   ' + `${R.score} pts`, W - M, y + 2, { align: 'right' });
  y += 10;
  h2('Mission');
  kv([['Vehicle', R.vehicle], ['Launch site', R.site], ['Lift-off (UTC)', R.launchUTC.replace('T', ' ').slice(0, 19)], ['Launch slip', `${R.slip} s`],
    ['Target orbit', `${R.target.alt} km, ${R.target.inc} deg`], ['Payload', `${R.payloadKg.toLocaleString()} kg`],
    ['Insertion', R.insertion ? `${R.insertion.apo.toFixed(1)} x ${R.insertion.peri.toFixed(1)} km, ${R.insertion.inc.toFixed(2)} deg` : 'not reached'],
    ['Insertion time', R.insertion ? `T+${Math.round(R.insertion.t)} s` : '-'], ['Max-Q', `${(R.maxQ / 1000).toFixed(1)} kPa at T+${Math.round(R.maxQAt)} s`],
    ['Max acceleration', `${R.maxG.toFixed(2)} g`], ['Avoidance delta-v', `${R.avoidDv.toFixed(2)} m/s`], ['Upper stage', R.disposed ? 'de-orbited' : 'left in orbit'],
    ['Catalog', `${R.catalog.objects?.toLocaleString?.() ?? '?'} objects · ${R.catalog.dataset || ''}`], ['Sky at launch', R.daylight]]);
  h2('Charts');
  for (const s of specs(R)) img(s);
  h2('Score');
  kv(R.scoreRows.map(([k, v]) => [k, `${v > 0 ? '+' : ''}${v}`]));
  h2('Conjunctions on the launch trajectory (pre-flight screening)');
  if (!R.conjunctions.length) para('Nothing came within 25 km of the trajectory.');
  else {
    const cols = [['Risk', 0], ['Object', 14], ['Type', 74], ['Miss km', 102], ['Rel km/s', 122], ['Pc', 142], ['TCA (UTC)', 160]];
    doc.setFontSize(7.8); doc.setFont('helvetica', 'bold'); doc.setTextColor(95, 104, 118); cols.forEach(([t, x]) => doc.text(t, M + x, y)); y += 4.4;
    doc.setFont('helvetica', 'normal');
    for (const c of R.conjunctions.slice(0, 30)) {
      if (y > 280) { doc.addPage(); header(R.mission || 'Free flight'); doc.setFontSize(7.8); }
      const col = c.risk === 'RED' ? [220, 30, 50] : c.risk === 'AMBER' ? [200, 130, 0] : [30, 150, 80];
      doc.setTextColor(...col); doc.text(c.risk, M, y); doc.setTextColor(30, 36, 48);
      doc.text(A(c.name).slice(0, 30), M + 14, y); doc.text(A(c.type), M + 74, y); doc.text(c.miss.toFixed(3), M + 102, y);
      doc.text(c.relSpeed.toFixed(2), M + 122, y); doc.text(c.pc < 1e-12 ? '<1e-12' : c.pc.toExponential(1), M + 142, y); doc.text(c.tcaUTC.slice(11, 19), M + 160, y);
      y += 4.2;
    }
    y += 2;
  }
  if (R.passes.length) { h2('Close approaches flown'); kv(R.passes.map((p) => [`${p.name} (${p.risk})`, `${p.miss.toFixed(2)} km · Pc ${p.pc.toExponential(1)} · ${p.hit ? 'COLLISION' : 'missed'}`]), 1); }
  h2('Models used');
  for (const t of MODELS) para(t, 8.2);
  para('Full equations, derivations and limits: sentinelflight.poelys.com/science (downloadable PDF).', 8.2);
  footer();
  doc.save(slug(R) + '_report.pdf');
}

const MODELS = [
  'Rocket equation: delta-v = Isp · g0 · ln(m0 / mf), summed over stages. Thrust F = F_vac - (F_vac - F_sl) · p / p0, mass flow from the vacuum Isp.',
  'Ascent: RK4 integration in the inertial TEME frame. Gravity with the J2 oblateness term, drag D = 1/2 · rho · v_rel^2 · Cd(Mach) · A against the rotating air in the U.S. Standard Atmosphere 1976.',
  'Losses: ideal delta-v (integral of thrust/mass) - gravity loss (integral of -g along the velocity) - drag loss (integral of -drag/mass along the velocity) - steering loss (integral of a_T(1 - cos of thrust-to-velocity angle)) = speed gained. The accounting closes.',
  'Catalog: every object propagated with SGP4 from public two-line elements; cubic Hermite interpolation between 60 s samples; closest approach in closed form, refined by golden-section search.',
  'Collision probability: 2-D Gaussian in the encounter plane, Pc = P(chi^2(2, lambda = (miss/sigma)^2) <= (HBR/sigma)^2), with sigma = 0.05 km + 0.61 km/day x element-set age (back-tested). RED: Pc >= 1e-4 or miss < 1 km.',
  'Sentinel: a Double DQN agent (48-number state, 7 actions: commit, slip, altitude, phasing burn), every plan re-screened against the catalog, with a guard that falls back to exhaustive search if anything is still RED.',
];
