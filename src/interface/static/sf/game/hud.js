// Flight HUD: telemetry, stages, orbit, live charts, attitude indicator, event feed.
import { G0 } from '../physics/constants.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
export const clock = (t) => {
  const s = Math.abs(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

export class HUD {
  constructor() { this.calloutTimer = 0; this.lastStages = ''; }

  reset(sim, missionLabel) {
    $('hud-mission').innerHTML = `<b>${missionLabel}</b>${sim.veh.name} · ${sim.site.name}`;
    $('hud-events').innerHTML = '';
    this.sim = sim;
  }

  telemetry(s, sim) {
    const qL = sim.veh.qLimit;
    const rows = [
      ['ALTITUDE', `${fmt(s.alt, s.alt < 100 ? 2 : 1)}<small>km</small>`],
      ['VELOCITY', `${fmt(s.speed)}<small>m/s</small>`],
      ['AIRSPEED', `${fmt(s.airspeed)}<small>m/s</small>`],
      ['VERT SPEED', `${fmt(s.vs)}<small>m/s</small>`],
      ['DOWNRANGE', `${fmt(s.downrange, 1)}<small>km</small>`],
      ['MACH', fmt(s.mach, 2)],
      ['DYN. PRESSURE', `${fmt(s.q / 1000, 1)}<small>kPa</small>`],
      ['__gauge', [s.q / (qL * 1.3), 1 / 1.3, s.q > qL ? 'var(--red)' : s.q > 0.78 * qL ? 'var(--amber)' : 'var(--cyan)']],
      ['ACCEL', `${fmt(s.g, 2)}<small>g</small>`],
      ['__gauge', [s.g / (sim.veh.gLimit * 1.6), 1 / 1.6, s.g > sim.veh.gLimit ? 'var(--red)' : 'var(--cyan)']],
      ['PITCH', `${fmt(s.pitch, 1)}<small>°</small>`],
      ['ANGLE OF ATTACK', `${fmt(s.aoa, 1)}<small>°</small>`],
      ['THROTTLE', `${fmt(s.throttle * 100)}<small>%</small>`],
      ['AMBIENT', `${fmt(s.pressure / 1000, s.pressure < 100 ? 3 : 1)}<small>kPa</small>`],
    ];
    $('hud-tele').innerHTML = '<div class="tele">' + rows.map(([k, v]) => k === '__gauge'
      ? `<div class="gauge"><i style="width:${Math.min(100, v[0] * 100)}%;background:${v[2]}"></i><em style="left:${v[1] * 100}%"></em></div>`
      : `<span>${k}</span><b>${v}</b>`).join('') + '</div>';
  }

  stages(sim) {
    const v = sim.veh, out = [];
    if (v.boosters) {
      sim.boosterGroups.forEach((g, i) => {
        const frac = g.prop / v.boosters.prop;
        const name = g.airLit ? `${v.boosters.name} (air-lit)` : v.boosters.name;
        out.push(`<div class="stg ${g.attached ? (g.lit ? 'active' : '') : 'gone'}"><div class="t"><span>${name} ×${g.n}</span><span>${g.attached ? fmt(frac * 100) + '%' : 'SEP'}</span></div><div class="b"><i style="width:${frac * 100}%"></i></div></div>`);
      });
    }
    v.stages.forEach((st, i) => {
      const frac = sim.prop[i] / st.prop;
      const cls = i < sim.stage ? 'gone' : i === sim.stage ? 'active' : '';
      const ve = st.ispVac * G0;
      out.push(`<div class="stg ${cls}"><div class="t"><span>${st.name} · ${st.engine}</span><span>${i < sim.stage ? 'SEP' : fmt(frac * 100) + '%'}</span></div><div class="b"><i style="width:${Math.max(0, frac) * 100}%"></i></div></div>`);
    });
    out.push(`<div class="kv"><span>Mass</span><span>${fmt(sim.snap.mass / 1000, 2)} t</span></div><div class="kv"><span>Δv remaining (vac)</span><span>${fmt(sim.snap.dvLeft)} m/s</span></div>`);
    $('hud-stages').innerHTML = out.join('');
  }

  orbit(s, sim) {
    const tA = sim.hTarget / 1000;
    const good = (x) => Math.abs(x - tA) < tA * 0.03 ? 'ok' : '';
    $('hud-orbit').innerHTML = `
      <div class="kv"><span>Apoapsis</span><span class="${good(s.apo)}">${s.apo > -1000 ? fmt(s.apo, 1) + ' km' : '—'}</span></div>
      <div class="kv"><span>Periapsis</span><span class="${good(s.peri)}">${s.peri > -1000 ? fmt(s.peri, 1) + ' km' : 'sub-orbital'}</span></div>
      <div class="kv"><span>Inclination</span><span>${fmt(s.inc, 2)}° <span class="muted">/ ${fmt(sim.inc * 180 / Math.PI, 2)}°</span></span></div>
      <div class="kv"><span>Target</span><span>${fmt(tA)} km circular</span></div>
      <div class="kv"><span>Losses g / drag / steer</span><span>${fmt(sim.losses.gravity)} / ${fmt(sim.losses.drag)} / ${fmt(sim.losses.steering)}</span></div>`;
  }

  chart(id, data, key, color, label, limit) {
    const c = $(id), g = c.getContext('2d'), w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(134,150,173,.8)'; g.font = '10px JetBrains Mono'; g.fillText(label, 4, 11);
    if (data.length < 2) return;
    const xs = data.map((d) => d.t), ys = data.map((d) => key(d));
    const x0 = xs[0], x1 = xs[xs.length - 1] || 1, y1 = Math.max(...ys, limit || 0) * 1.1 || 1;
    if (limit) { g.strokeStyle = 'rgba(255,77,94,.6)'; g.setLineDash([4, 3]); g.beginPath(); const y = h - 4 - (limit / y1) * (h - 18); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.setLineDash([]); }
    g.strokeStyle = color; g.lineWidth = 1.6; g.beginPath();
    data.forEach((d, i) => { const x = ((xs[i] - x0) / (x1 - x0 || 1)) * (w - 4) + 2, y = h - 4 - (ys[i] / y1) * (h - 18); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }

  attitude(s) {
    const c = $('att'), g = c.getContext('2d'), w = c.width, R = w / 2 - 6;
    g.clearRect(0, 0, w, w);
    g.save(); g.translate(w / 2, w / 2);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();
    const off = (s.pitch / 90) * R;
    g.fillStyle = '#0b2b4a'; g.fillRect(-R, -R, 2 * R, R + off);
    g.fillStyle = '#3a2a1a'; g.fillRect(-R, off, 2 * R, R - off + R);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
    for (let p = -80; p <= 80; p += 10) { const y = off - (p / 90) * R; g.beginPath(); g.moveTo(-14 - (p % 30 ? 0 : 10), y); g.lineTo(14 + (p % 30 ? 0 : 10), y); g.stroke(); }
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(-R, off); g.lineTo(R, off); g.stroke();
    g.restore();
    g.strokeStyle = 'var(--cyan)'; g.strokeStyle = '#38e1ff'; g.lineWidth = 2; g.beginPath(); g.arc(w / 2, w / 2, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#ffb547'; g.lineWidth = 3; g.beginPath(); g.moveTo(w / 2 - 26, w / 2); g.lineTo(w / 2 - 8, w / 2); g.lineTo(w / 2, w / 2 + 6); g.lineTo(w / 2 + 8, w / 2); g.lineTo(w / 2 + 26, w / 2); g.stroke();
    g.fillStyle = '#e6eef8'; g.font = '11px JetBrains Mono'; g.textAlign = 'center';
    g.fillText(`${s.pitch.toFixed(1)}°`, w / 2, w - 10);
    g.fillText(`α ${s.aoa.toFixed(1)}°`, w / 2, 18);
  }

  update(sim, warp, frameNo, wanted = warp) {
    const s = sim.snap;
    if (!s || s.alt === undefined) return;
    this.telemetry(s, sim);
    if (frameNo % 3 === 0) { this.stages(sim); this.orbit(s, sim); }
    if (frameNo % 10 === 0) {
      const tel = sim.telemetry.slice(-1200);
      this.chart('ch-alt', tel, (d) => d.alt, '#38e1ff', 'ALTITUDE km');
      this.chart('ch-q', tel.filter((d) => d.t < (sim.insertion?.t ?? 1e9)), (d) => d.q / 1000, '#ffb547', 'DYN. PRESSURE kPa', sim.veh.qLimit / 1000);
    }
    this.attitude(s);
    $('hud-warp').textContent = wanted > warp ? `${warp}× (${wanted}× set)` : `${warp}×`;
  }

  event(e, cls = '') {
    const el = document.createElement('div');
    el.className = 'ev ' + cls;
    el.innerHTML = `<b>T+${clock(e.t)}</b>${e.label}${e.detail ? ` <span class="muted">· ${e.detail}</span>` : ''}`;
    const box = $('hud-events');
    box.prepend(el);
    while (box.children.length > 9) box.lastChild.remove();
  }

  callout(text, sub = '', ms = 2600) {
    const c = $('hud-callout');
    c.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    c.classList.add('show');
    clearTimeout(this.calloutTimer);
    this.calloutTimer = setTimeout(() => c.classList.remove('show'), ms);
  }
}
