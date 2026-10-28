// SentinelFlight: game controller.
import { Views, CatalogCloud, toThree } from './scene.js';
import { HUD, clock } from './hud.js';
import { Audio } from './audio.js';
import { MISSIONS, loadProgress, saveResult, unlocked, scoreMission } from './missions.js';
import { MissionPlan, loadCatalog, injectThreats, rng } from './plan.js';
import { VEHICLES, SITES, vehicleById, deltaVBudget, liftoffTWR } from '../physics/vehicles.js';
import { FlightSim, launchAzimuth } from '../physics/flight.js';
import { propagate, elements, rk4Coast, circularSpeed } from '../physics/orbit.js';
import { geodeticToEcef, rotZ, unit, norm, rtnBasis } from '../physics/frames.js';
import { gmst, julian, fmtUTC } from '../physics/time.js';
import { Path, screen, conjunctions, summarize, riskLevel } from '../physics/collision.js';
import { DDQNPolicy, planGuarded, counts } from '../ai/sentinel.js';
import { G0, MU, RE } from '../physics/constants.js';

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));
const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const pcFmt = (p) => (p < 1e-12 ? '< 1e-12' : p.toExponential(1));

const views = new Views($('view'));
const hud = new HUD();
const audio = new Audio();
let policy = null;
DDQNPolicy.load('/static/sf/data/ddqn_policy.json').then((p) => { policy = p; }).catch(() => { policy = null; });

const G = {
  screen: 'title', prev: [], mission: null, cfg: null, plan: null, chosen: { slip: 0, dalt: 0, dv: 0 }, res: null,
  sim: null, warp: 1, paused: false, countdown: null, frame: 0, catalog: null, ops: null, launchArmed: false,
};

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ── navigation ──────────────────────────────────────────────────────────────
function show(name, push = true) {
  if (push && G.screen !== name) G.prev.push(G.screen);
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name));
  G.screen = name;
  views.controls.autoRotate = name === 'title' || name === 'campaign';
  views.controls.autoRotateSpeed = 0.35;
  views.setGlobeShift(name === 'title' ? 0.2 : 0);
  if (name !== 'flight') views.mode = 'globe';
  if (name === 'campaign') renderCampaign();
  if (name === 'manual') renderManual();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  const go = b.dataset.go;
  audio.init();
  if (go === 'back') return show(G.prev.pop() || 'title', false);
  if (go === 'free') { G.mission = null; openHangar(); return; }
  if (go === 'hangar') { if (G.screen === 'debrief') return openHangar(G.mission); return show('hangar'); }
  show(go);
});

// ── title: live catalog on the globe + SGP4 cross-check ─────────────────────
async function boot() {
  try {
    const cat = await loadCatalog();
    G.catalog = cat;
    const m = cat.meta;
    G.refMs = Date.parse(m.reference_epoch);
    const types = m.object_types || {};
    $('data-text').innerHTML = `${m.objects.toLocaleString()} objects tracked · ${m.dataset === 'live' ? 'LIVE' : 'archived snapshot'} · newest element set ${fmtUTC(new Date(G.refMs))}`
      + (m.partial_catalog ? ' · <span class="warn">partial public catalog</span>' : '')
      + `<br><span class="muted">${(types.PAYLOAD || 0).toLocaleString()} payloads · ${(types.DEBRIS || 0).toLocaleString()} debris · ${(types['ROCKET BODY'] || 0).toLocaleString()} rocket bodies</span>`;
    views.setCatalog(new CatalogCloud(cat.rows, G.refMs));
    G.titleTime = G.refMs;
    sgp4CrossCheck(cat).catch(() => { $('sgp4-check').textContent = ''; });
  } catch (e) {
    $('data-text').textContent = 'Catalog unavailable: ' + e.message;
  }
}

async function sgp4CrossCheck(cat) {
  const sat = await import('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.es.js');
  const pick = cat.rows.filter((r) => r[0] === 25544).concat(cat.rows.filter((_, i) => i % Math.floor(cat.rows.length / 6) === 0).slice(0, 6));
  const t = new Date(G.refMs + 3600e3);
  const ref = await (await fetch(`/api/sgp4-check?ids=${pick.map((r) => r[0]).join(',')}&t=${t.toISOString()}`)).json();
  let worst = 0, n = 0;
  for (const r of pick) {
    const p = ref.positions[r[0]];
    if (!p || p.error) continue;
    const rec = sat.twoline2satrec(r[9], r[10]);
    const js = sat.propagate(rec, t).position;
    if (!js) continue;
    worst = Math.max(worst, Math.hypot(js.x - p.r_km[0], js.y - p.r_km[1], js.z - p.r_km[2]) * 1000);
    n++;
  }
  G.sgp4Check = { worst, n };
  $('sgp4-check').innerHTML = `SGP4 cross-check · browser (satellite.js) vs server (python-sgp4)<br><b class="${worst < 10 ? 'ok' : 'warn'}">${n} objects · max difference ${worst < 1 ? worst.toFixed(3) : worst.toFixed(1)} m</b>`;
}

// ── campaign ────────────────────────────────────────────────────────────────
function renderCampaign() {
  const prog = loadProgress();
  let total = 0;
  $('mission-grid').innerHTML = MISSIONS.map((m, i) => {
    const st = prog[m.id]?.stars || 0; total += st;
    const lock = !unlocked(i);
    const v = vehicleById(m.vehicle);
    return `<div class="mission ${lock ? 'locked' : ''}" data-m="${i}">
      <div class="num">MISSION ${String(m.n).padStart(2, '0')}</div><h4>${m.name}</h4>
      <div class="veh">${v.name} · ${SITES[m.site].name.split(',')[0]} · ${m.alt} km · ${m.inc}°</div>
      <p>${m.brief}</p>
      <div class="foot"><span class="diff">${m.difficulty}</span><span class="stars">${'★'.repeat(st)}<span class="off">${'★'.repeat(3 - st)}</span></span></div></div>`;
  }).join('');
  $('total-stars').textContent = `★ ${total} / ${MISSIONS.length * 3}`;
  document.querySelectorAll('.mission').forEach((el) => el.onclick = () => {
    const i = +el.dataset.m;
    if (!unlocked(i)) return toast('Earn at least one star on the previous mission to unlock this one.');
    openHangar(MISSIONS[i]);
  });
}

// ── hangar ──────────────────────────────────────────────────────────────────
function windowBounds() {
  const ref = G.refMs || Date.now();
  return [ref - 3 * 86400e3, ref + 2 * 86400e3];
}
const localInput = (ms) => new Date(ms).toISOString().slice(0, 16);

function openHangar(mission = G.mission) {
  G.mission = mission;
  const v = vehicleById(mission ? mission.vehicle : (G.cfgVehicle || 'falcon9'));
  $('hangar-title').textContent = mission ? `Mission ${mission.n}: ${mission.name}` : 'Free flight';
  $('brief').innerHTML = mission ? `${mission.brief}<div class="obj">${mission.objectives.map((o) => `<span>◎ ${o}</span>`).join('')}</div>` : 'Pick any vehicle, site and orbit. The sky is the real catalog at the chosen time.';
  $('vehicle-list').innerHTML = VEHICLES.map((x) => `<div class="vcard ${x.id === v.id ? 'sel' : ''} ${mission && x.id !== v.id ? 'locked' : ''}" data-v="${x.id}"><b>${x.name}</b><small>${x.maker} · ${x.country}</small></div>`).join('');
  document.querySelectorAll('.vcard').forEach((el) => el.onclick = () => { G.cfgVehicle = el.dataset.v; selectVehicle(vehicleById(el.dataset.v)); });
  const [lo, hi] = windowBounds();
  $('cfg-time').min = localInput(lo); $('cfg-time').max = localInput(hi);
  const t0 = mission ? Math.min(hi - 3600e3, (G.refMs || Date.now()) + mission.offsetH * 3600e3) : (G.refMs || Date.now()) + 2 * 3600e3;
  $('cfg-time').value = localInput(Math.round(t0 / 300e3) * 300e3);
  selectVehicle(v, mission);
  show('hangar');
}

function selectVehicle(v, mission = G.mission) {
  document.querySelectorAll('.vcard').forEach((el) => el.classList.toggle('sel', el.dataset.v === v.id));
  G.vehicle = v;
  $('cfg-site').innerHTML = v.sites.map((s) => `<option value="${s}">${SITES[s].name}</option>`).join('');
  if (mission) $('cfg-site').value = mission.site;
  const plStep = v.payload.max > 5000 ? 100 : 10;
  $('cfg-pl').step = plStep; $('cfg-pl').min = plStep; $('cfg-pl').max = v.payload.max;
  $('cfg-pl').value = mission ? mission.payload : v.payload.default;
  $('cfg-alt').value = mission ? mission.alt : 550;
  $('cfg-inc').value = mission ? mission.inc : Math.ceil(Math.abs(SITES[v.sites[0]].lat) * 10) / 10 + 0.5;
  $('cfg-window').value = mission ? mission.window : 600;
  for (const id of ['cfg-site', 'cfg-pl', 'cfg-alt', 'cfg-inc', 'cfg-window']) $(id).disabled = !!mission;   // campaign missions fix the orbit; you choose the time
  $('cfg-time').disabled = false;
  const stages = [...(v.boosters ? [{ ...v.boosters, name: `${v.boosters.name} ×${v.boosters.count}` }] : []), ...v.stages];
  $('vehicle-hero').innerHTML = `<div class="maker">${v.maker} · ${v.country}</div><h4>${v.name}</h4><p>${v.blurb}</p>
    <table class="stage-table"><tr><th>Stage</th><th>Engine</th><th>Thrust (vac)</th><th>Isp vac</th><th>Propellant</th><th>Burn</th></tr>
    ${stages.map((s) => `<tr><td>${s.name}</td><td>${s.engine}</td><td>${fmt(s.thrustVac / 1000)} kN</td><td>${s.ispVac} s</td><td>${fmt(s.prop / 1000, 1)} t</td><td>${fmt(s.prop / (s.thrustVac / (s.ispVac * G0)))} s</td></tr>`).join('')}</table>`;
  updatePerf();
}
for (const id of ['cfg-site', 'cfg-pl', 'cfg-alt', 'cfg-inc', 'cfg-window', 'cfg-time']) $(id).addEventListener('input', updatePerf);

function readCfg() {
  const site = SITES[$('cfg-site').value];
  return { vehicle: G.vehicle, site, payloadKg: +$('cfg-pl').value, targetAltKm: +$('cfg-alt').value, targetIncDeg: +$('cfg-inc').value,
    launchDate: new Date($('cfg-time').value + ':00Z'), slipMax: +$('cfg-window').value };
}

function updatePerf() {
  const c = readCfg(), v = c.vehicle;
  $('v-alt').textContent = `${c.targetAltKm} km`; $('v-inc').textContent = `${c.targetIncDeg.toFixed(1)}°`;
  $('v-pl').textContent = `${fmt(c.payloadKg)} kg`;
  const budget = deltaVBudget(v, c.payloadKg), twr = liftoffTWR(v, c.payloadKg);
  const r0 = rotZ(geodeticToEcef(c.site.lat, c.site.lon), 0);
  const az = launchAzimuth(c.site, r0, c.targetAltKm, c.targetIncDeg, c.site.branch === 'south' ? 'south' : 'north');
  const vOrb = circularSpeed(RE + c.targetAltKm * 1000);
  const rP = RE + 200e3, rA = RE + c.targetAltKm * 1000;
  const hoh = c.targetAltKm > 260 ? Math.sqrt(MU * (2 / rP - 2 / (rP + rA))) - circularSpeed(rP) + circularSpeed(rA) - Math.sqrt(MU * (2 / rA - 2 / (rP + rA))) : 0;
  const assist = 465 * Math.cos(c.site.lat * Math.PI / 180) * Math.sin(az.inertialDeg * Math.PI / 180);
  const need = circularSpeed(rP) + hoh + 1500 - assist;
  const margin = budget.total - need;
  const colors = ['#38e1ff', '#7dd3fc', '#ffb547', '#a78bfa', '#3ee38c'];
  $('perf').innerHTML = `
    <div class="kv"><span>Ideal Δv (rocket equation)</span><span>${fmt(budget.total)} m/s</span></div>
    <div class="dvbar">${budget.phases.map((p, i) => `<i style="width:${p.dv / budget.total * 100}%;background:${colors[i % 5]}" title="${p.name}"></i>`).join('')}</div>
    <div class="dvlegend">${budget.phases.map((p, i) => `<span style="color:${colors[i % 5]}">■ ${p.name} ${fmt(p.dv)}</span>`).join('')}</div>
    <div class="kv"><span>Needed (orbit ${fmt(vOrb)} + transfer ${fmt(hoh)} + ~1500 losses − Earth ${fmt(assist)})</span><span>${fmt(need)} m/s</span></div>
    <div class="kv"><span>Margin</span><span class="${margin > 300 ? 'ok' : margin > 0 ? 'warn' : 'bad'}">${margin > 0 ? '+' : ''}${fmt(margin)} m/s</span></div>
    <div class="kv"><span>Lift-off thrust / weight</span><span class="${twr > 1.15 ? 'ok' : twr > 1 ? 'warn' : 'bad'}">${twr.toFixed(2)}</span></div>
    <div class="kv"><span>Launch azimuth (inertial / ground)</span><span>${az.inertialDeg.toFixed(1)}° / ${az.rotatingDeg.toFixed(1)}°</span></div>
    <div class="kv"><span>Max dynamic pressure allowed</span><span>${fmt(v.qLimit / 1000)} kPa</span></div>`;
  let hint = '';
  if (!az.reachable) hint = `Inclination ${c.targetIncDeg}° is below the site's geocentric latitude (${az.minIncDeg.toFixed(2)}°): the orbit plane must pass through the pad. A dog-leg would cost a lot of Δv.`;
  else if (twr < 1.05) hint = 'Lift-off thrust barely exceeds weight: reduce the payload.';
  else if (margin < 0) hint = 'Estimated Δv margin is negative: the flight computer may not reach orbit. Lower the payload or the altitude.';
  const [lo, hi] = windowBounds();
  if (c.launchDate.getTime() < lo || c.launchDate.getTime() > hi) hint = 'Launch time must be within the catalog window (element sets are only accurate for a few days).';
  $('cfg-hint').textContent = hint;
  $('btn-prepare').disabled = !!hint && (!az.reachable || twr < 1.0 || hint.startsWith('Launch time'));
}

// ── pre-flight ──────────────────────────────────────────────────────────────
$('btn-prepare').onclick = async () => {
  audio.init();
  const cfg = readCfg();
  G.cfg = cfg;
  show('prep');
  $('prep-log').innerHTML = ''; $('prep-bar').style.width = '0%';
  const log = (msg) => { const d = document.createElement('div'); d.textContent = msg; $('prep-log').append(d); };
  let last = '';
  const plan = new MissionPlan({ ...cfg });
  try {
    await plan.prepare((msg, f) => { $('prep-bar').style.width = `${(f * 85).toFixed(0)}%`; if (msg !== last) { log(msg); last = msg; } });
  } catch (e) { log('Error: ' + e.message); toast('Pre-flight failed: ' + e.message, 5000); return; }
  if (plan.error) {
    log(`Flight computer: no ascent reaches orbit (${plan.error.label}: ${plan.error.detail}).`);
    toast('This configuration cannot reach orbit. Lower the payload or altitude.', 5000);
    setTimeout(() => show('hangar'), 2500);
    return;
  }
  const ins = plan.flightFor(0).sim.insertion;
  log(`Ascent: pitch kick ${plan.kickDeg.toFixed(1)}°, insertion ${(ins.el.apoAlt / 1000).toFixed(0)} × ${(ins.el.periAlt / 1000).toFixed(0)} km at T+${clock(ins.t)}, ${fmt(ins.dvLeft)} m/s left`);
  log(`SGP4: ${plan.stats.band.toLocaleString()} objects in the altitude band, ${plan.stats.kept.toLocaleString()} within the ${fmt(plan.keepKm)} km maneuver envelope (${(plan.stats.sgp4Ms / 1000).toFixed(1)} s)`);
  const m = G.mission;
  if (m?.threats) {
    const nom = plan.pathFor({ slip: 0, dalt: 0, dv: 0 });
    plan.eph = injectThreats(plan.eph, nom, rng(m.seed || 1), m.threats, { tA: plan.slipMax + 300, tB: plan.slipMax + plan.horizon - 600, parent: 'FRAGMENT CLOUD' });
    log(`Intelligence: ${m.threats} debris event${m.threats > 1 ? 's' : ''} cross the nominal trajectory`);
  }
  log('Scanning the launch window');
  plan.blackoutData = [];
  const step = 60;
  for (let s = -plan.slipMax; s <= plan.slipMax + 1e-9; s += step) {
    const r = plan.screenPlan({ slip: s, dalt: 0, dv: 0 });
    plan.blackoutData.push({ slip: s, ...r.summary });
    $('prep-bar').style.width = `${85 + 15 * (s + plan.slipMax) / Math.max(1, 2 * plan.slipMax)}%`;
    await tick();
  }
  G.plan = plan;
  G.chosen = { slip: 0, dalt: 0, dv: 0 };
  G.launchArmed = false;
  openCola();
};

// ── launch COLA ─────────────────────────────────────────────────────────────
function openCola() {
  const p = G.plan;
  $('plan-slip').min = -p.slipMax; $('plan-slip').max = p.slipMax; $('plan-slip').value = 0;
  $('plan-slip').disabled = p.slipMax === 0;
  $('plan-dalt').value = 0; $('plan-dv').value = 0;
  $('cola-stats').textContent = `${p.stats.kept.toLocaleString()} objects screened · envelope ${fmt(p.envelopeKm)} km`;
  $('ai-out').textContent = 'Ask Sentinel for the cheapest safe plan. It searches slip, insertion altitude and phasing burn; every plan it proposes is independently re-screened.';
  show('cola');
  views.clearGlobeLayer();
  evaluatePlan();
  drawBlackout();
}

function evaluatePlan() {
  const p = G.plan;
  G.chosen = { slip: +$('plan-slip').value, dalt: +$('plan-dalt').value, dv: +$('plan-dv').value };
  $('v-slip').textContent = `${G.chosen.slip > 0 ? '+' : ''}${G.chosen.slip} s`;
  $('v-dalt').textContent = `${G.chosen.dalt > 0 ? '+' : ''}${G.chosen.dalt} km`;
  $('v-dv').textContent = `${G.chosen.dv > 0 ? '+' : ''}${G.chosen.dv} m/s`;
  const res = p.screenPlan(G.chosen);
  G.res = res;
  const rows = p.conj(res);
  G.conjRows = rows;
  const s = res.summary;
  const state = s.red ? 'RED' : s.amber ? 'AMBER' : 'GREEN';
  const launch = new Date(p.cfg.launchDate.getTime() + G.chosen.slip * 1000);
  $('plan-verdict').innerHTML = `<span class="pill ${state}">${state === 'GREEN' ? 'CLEAR' : state}</span> <span class="big">${state === 'RED' ? 'NO-GO' : 'GO'}</span><br>
    Lift-off ${fmtUTC(launch)} · ${s.red} RED · ${s.amber} AMBER · closest ${fmt(s.minMiss, 2)} km · total Pc ${pcFmt(s.totalPc)}`;
  $('go-sub').textContent = state === 'RED' ? 'RED conjunction: click twice to launch anyway' : `Lift-off ${fmtUTC(launch)}`;
  $('conj-table').innerHTML = `<tr><th>Risk</th><th>Object</th><th>Type</th><th>Miss km</th><th>R / T / N km</th><th>Rel. speed</th><th>Pc</th><th>Time</th></tr>` +
    (rows.length ? rows.slice(0, 40).map((c) => `<tr><td><span class="pill ${c.risk}">${c.risk}</span></td><td class="name">${c.name} <span class="muted">#${c.id > 0 ? c.id : 'synthetic'}</span></td><td>${c.type}</td><td>${fmt(c.miss, 3)}</td><td>${fmt(c.radial, 2)} / ${fmt(c.along, 2)} / ${fmt(c.cross, 2)}</td><td>${fmt(c.relSpeed, 2)} km/s</td><td>${pcFmt(c.pc)}</td><td>T+${clock(c.tca - p.slipMax - G.chosen.slip)}</td></tr>`).join('')
      : '<tr><td colspan="8" class="name muted">Nothing within 25 km of this trajectory.</td></tr>');
  drawPlanOnGlobe(res, rows);
  drawBlackout();
}
for (const id of ['plan-slip', 'plan-dalt', 'plan-dv']) $(id).addEventListener('input', () => { G.launchArmed = false; evaluatePlan(); });

function drawPlanOnGlobe(res, rows) {
  views.clearGlobeLayer();
  views.line(res.path, 0x38e1ff, 0.9);
  const st = new Float64Array(6);
  for (const c of rows.slice(0, 12)) {
    G.plan.eph.state(c.i, c.tca, st);
    views.marker([st[0], st[1], st[2]], c.risk === 'RED' ? 0xff4d5e : c.risk === 'AMBER' ? 0xffb547 : 0x3ee38c, 0.06);
  }
}

function drawBlackout() {
  const cv = $('blackout'), p = G.plan, data = p.blackoutData || [];
  const dpr = devicePixelRatio || 1, W = cv.clientWidth * dpr, H = 220 * dpr;
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const pad = 40 * dpr, top = 14 * dpr, bot = 26 * dpr;
  const yOf = (km) => { const l = Math.log10(Math.min(200, Math.max(0.05, km))); return top + (1 - (l - Math.log10(0.05)) / (Math.log10(200) - Math.log10(0.05))) * (H - top - bot); };
  const span = Math.max(1, 2 * p.slipMax), xOf = (s) => pad + ((s + p.slipMax) / span) * (W - pad * 1.4);
  g.font = `${11 * dpr}px JetBrains Mono`; g.fillStyle = '#8696ad';
  for (const km of [0.1, 1, 5, 25, 100]) {
    const y = yOf(km); g.strokeStyle = km === 1 ? 'rgba(255,77,94,.5)' : km === 5 ? 'rgba(255,181,71,.45)' : 'rgba(120,170,220,.12)';
    g.beginPath(); g.moveTo(pad, y); g.lineTo(W, y); g.stroke(); g.fillText(`${km} km`, 2, y + 4 * dpr);
  }
  const bw = Math.max(4 * dpr, (W - pad * 1.4) / Math.max(1, data.length) * 0.7);
  for (const d of data) {
    const x = xOf(d.slip), y = yOf(d.minMiss);
    g.fillStyle = d.red ? '#ff4d5e' : d.amber ? '#ffb547' : '#3ee38c';
    g.globalAlpha = 0.85; g.fillRect(x - bw / 2, y, bw, H - bot - y); g.globalAlpha = 1;
  }
  const xs = xOf(G.chosen.slip);
  g.strokeStyle = '#38e1ff'; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(xs, top); g.lineTo(xs, H - bot); g.stroke(); g.lineWidth = 1;
  g.fillStyle = '#8696ad';
  for (let s = -p.slipMax; s <= p.slipMax; s += Math.max(60, p.slipMax / 5)) g.fillText(`${s > 0 ? '+' : ''}${s / 60}m`, xOf(s) - 10 * dpr, H - 8 * dpr);
  cv.onclick = (e) => {
    if (!p.slipMax) return;
    const x = (e.offsetX * dpr - pad) / (W - pad * 1.4) * span - p.slipMax;
    $('plan-slip').value = Math.round(x / 60) * 60;
    G.launchArmed = false;
    evaluatePlan();
  };
}

$('btn-ai').onclick = async () => {
  $('ai-out').innerHTML = '<span class="muted">Sentinel is thinking…</span>';
  await tick();
  const p = G.plan;
  const sc = p.scenario(p.slipMax);
  sc.slipMax = 600;   // the network was trained with slips normalised by a ±600 s grid
  const res = planGuarded(sc, policy);
  const f = counts(res.final);
  $('plan-slip').value = res.plan.slip; $('plan-dalt').value = res.plan.dalt; $('plan-dv').value = res.plan.dv;
  $('ai-out').innerHTML = `<b>${res.policy}${res.fallback ? ' → fallback' : res.polished ? ' → polished' : ''}</b> · ${res.screens} screenings · ${res.ms.toFixed(0)} ms
    <ol>${res.trace.map((t) => `<li>${t.label}${t.red !== undefined ? ` <span class="muted">(${t.red} RED, ${t.amber} AMBER)</span>` : ''}</li>`).join('') || '<li>Commit nominal plan</li>'}</ol>
    Result: ${f.red} RED, ${f.amber} AMBER. ${res.fallback ? 'The learned plan failed verification, so the guard searched instead.' : 'Verified by an independent re-screen.'}`;
  G.launchArmed = false;
  evaluatePlan();
};

$('btn-golaunch').onclick = () => {
  if (G.res.summary.red && !G.launchArmed) { G.launchArmed = true; toast('RED conjunction on this plan. Click again to launch anyway.'); return; }
  startFlight();
};

// ── flight ──────────────────────────────────────────────────────────────────
const CAMS = [['chase', 'Chase'], ['pad', 'Tracking'], ['onboard', 'Onboard'], ['map', 'Map']];
function startFlight() {
  const p = G.plan, c = p.cfg;
  const launch = new Date(c.launchDate.getTime() + G.chosen.slip * 1000);
  const sim = new FlightSim({ vehicle: c.vehicle, site: c.site, payloadKg: c.payloadKg, targetAltKm: c.targetAltKm + G.chosen.dalt,
    targetIncDeg: c.targetIncDeg, launchDate: launch, kickDeg: p.kickDeg, guidanceBiasKm: p.guidanceBiasKm || 0, branch: c.branch });
  G.sim = sim;
  G.offset = p.slipMax + G.chosen.slip;            // ephemeris time = offset + sim.t
  G.watch = { res: G.res, rows: G.conjRows };     // what we are tracking for close approaches
  G.passes = []; G.resolved = new Set(); G.collision = null;
  G.ops = null; G.avoidDv = 0; G.disposed = false; G.trail = []; G.phasingDone = !G.chosen.dv;
  G.fragDue = G.mission?.fragmentation ? { ...G.mission.fragmentation, fired: false } : null;
  G.warp = 1; G.warpWanted = 1; G.paused = false; G.countdown = 10; G.ended = false;
  sim.onEvent = onSimEvent;
  hud.reset(sim, G.mission ? `Mission ${G.mission.n}: ${G.mission.name}` : 'Free flight');
  views.attachVehicle(c.vehicle);
  views.mode = 'local'; views.camMode = 'chase';
  $('ops').classList.add('hidden'); $('ca-alert').classList.add('hidden');
  $('hud-events').classList.remove('hidden'); document.querySelector('.hud-right').classList.remove('hidden');
  $('hud-keys').innerHTML = [['Space', 'stage / skip count'], ['W A S D', 'steer offset'], ['R', 'reset steering'], ['Shift / Ctrl', 'throttle'], ['T', 'autopilot'], [', .', 'time warp'], ['Esc', 'real time'], ['C', 'camera'], ['M', 'map'], ['P', 'pause'], ['N', 'mute']]
    .map(([k, d]) => `<span><kbd>${k}</kbd>${d}</span>`).join('');
  renderCams();
  show('flight');
  audio.init();
  audio.say('Ten');
}

function renderCams() {
  $('hud-cams').innerHTML = CAMS.map(([k, l]) => `<button class="${(views.mode === 'globe' ? 'map' : views.camMode) === k ? 'on' : ''}" data-cam="${k}">${l}</button>`).join('');
  document.querySelectorAll('[data-cam]').forEach((b) => b.onclick = () => setCam(b.dataset.cam));
}
function setCam(k) {
  if (k === 'map') views.mode = views.mode === 'globe' ? 'local' : 'globe';
  else { views.mode = 'local'; views.camMode = k; }
  if (views.mode === 'globe' && G.sim) {
    // look from above the orbit plane, not along it (an orbit seen edge-on is a straight line)
    const r = G.sim.r, v = G.sim.v;
    const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
    const hn = Math.hypot(...h);
    const up = toThree(h.map((x) => x / hn)), radial = toThree(r, 1e-6);
    views.controls.target.set(0, 0, 0);
    views.gCam.position.copy(radial.clone().multiplyScalar(1.9).add(up.multiplyScalar(11)));
  }
  renderCams();
}

const SAY = { liftoff: 'Liftoff', maxq: 'Max Q', booster_sep: 'Booster separation', stage_sep: 'Stage separation', fairing: 'Fairing separation',
  seco: 'Engine cutoff', circ_start: 'Circularization burn', orbit: 'Orbit insertion confirmed', breakup: 'Vehicle lost', crash: 'Vehicle lost', suborbital: 'Insufficient delta v' };
function onSimEvent(e) {
  const bad = ['breakup', 'crash', 'suborbital', 'overload', 'collision'].includes(e.key);
  hud.event(e, bad ? 'bad' : e.key === 'orbit' ? 'good' : '');
  if (['liftoff', 'maxq', 'booster_sep', 'stage_sep', 'fairing', 'seco', 'circ_start', 'orbit', 'breakup', 'crash', 'suborbital', 'overload'].includes(e.key)) {
    hud.callout(e.label.toUpperCase(), e.detail);
    if (SAY[e.key]) audio.say(SAY[e.key]);
  }
  if (e.key === 'orbit') setTimeout(enterOrbitOps, 600);
  if (bad) { G.warpWanted = 1; setTimeout(() => finishMission(), 4500); }
}

// keyboard
const keys = new Set();
addEventListener('keydown', (e) => {
  if (G.screen !== 'flight' || e.target.tagName === 'INPUT') return;
  keys.add(e.key.toLowerCase());
  const sim = G.sim;
  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      if (sim.phase === 'PAD') { G.countdown = 0; break; }
      if (sim.stageNow()) { /* event already logged */ } break;
    case '.': case '>': G.warp = nextWarp(1); break;
    case ',': case '<': G.warp = nextWarp(-1); break;
    case 'escape': G.warpWanted = 1; G.warp = 1; break;
    case 'c': { const order = ['chase', 'pad', 'onboard']; setCam(order[(order.indexOf(views.camMode) + 1) % 3]); break; }
    case 'm': setCam('map'); break;
    case 'p': G.paused = !G.paused; toast(G.paused ? 'Paused' : 'Resumed', 1000); break;
    case 'n': toast(audio.toggle() ? 'Sound off' : 'Sound on', 1000); break;
    case 'r': sim.steer.pitch = 0; sim.steer.yaw = 0; break;
    case 't': sim.manualThrottle = null; sim.steer.pitch = 0; sim.steer.yaw = 0; toast('Autopilot: full control', 1200); break;
    case 'x': sim.manualThrottle = 0; break;
    case 'z': sim.manualThrottle = 1; break;
    default:
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

const WARPS = [1, 2, 5, 10, 25, 50, 100, 250, 1000];
function warpCap() {
  const s = G.sim;
  if (!s || s.phase === 'PAD') return 1;
  if (G.closeApproach) return 5;
  const h = s.snap.alt ?? 0;
  if (s.phase === 'ASCENT' && s.engineOn) return h < 70 ? 10 : 50;
  if (s.engineOn) return 25;
  return 1000;
}
// the player sets a wanted warp; the effective warp is capped while engines fire or near a close
// approach and returns to the wanted value automatically afterwards
function nextWarp(dir) {
  let i = WARPS.indexOf(G.warpWanted) + dir;
  i = Math.max(0, Math.min(WARPS.length - 1, i));
  G.warpWanted = WARPS[i];
  const cap = warpCap();
  if (G.warpWanted > cap) toast(`${G.warpWanted}× set · limited to ${cap}× ${G.closeApproach ? 'near the close approach' : 'while the engines fire'}`, 1400);
  return Math.min(G.warpWanted, cap);
}

function applySteeringKeys(sim, dt) {
  const rate = 6 * dt;
  if (keys.has('w')) sim.steer.pitch = Math.min(60, sim.steer.pitch + rate);
  if (keys.has('s')) sim.steer.pitch = Math.max(-60, sim.steer.pitch - rate);
  if (keys.has('a')) sim.steer.yaw = Math.max(-60, sim.steer.yaw - rate);
  if (keys.has('d')) sim.steer.yaw = Math.min(60, sim.steer.yaw + rate);
  if (keys.has('shift')) sim.manualThrottle = Math.min(1, (sim.manualThrottle ?? sim.throttle) + 0.6 * dt);
  if (keys.has('control')) sim.manualThrottle = Math.max(0, (sim.manualThrottle ?? sim.throttle) - 0.6 * dt);
  const manual = sim.manualThrottle !== null || sim.steer.pitch || sim.steer.yaw;
  const ap = $('hud-ap');
  ap.textContent = manual ? `MANUAL ${sim.manualThrottle !== null ? 'THR ' : ''}${sim.steer.pitch || sim.steer.yaw ? `P${sim.steer.pitch.toFixed(0)} Y${sim.steer.yaw.toFixed(0)}` : ''}` : 'AUTOPILOT';
  ap.className = 'ap ' + (manual ? 'off' : 'on');
}

// impulsive burn on the current stage: rocket equation for the propellant used
function impulse(sim, dvVec) {
  const s = sim.stageDef, ve = s.ispVac * G0, m = sim.mass();
  let dv = norm(dvVec);
  if (dv < 1e-6) return 0;
  const need = m * (1 - Math.exp(-dv / ve));
  if (need > sim.prop[sim.stage]) { dv = ve * Math.log(m / (m - sim.prop[sim.stage])); dvVec = dvVec.map((x) => x / norm(dvVec) * dv); }
  sim.prop[sim.stage] -= m * (1 - Math.exp(-dv / ve));
  sim.v = sim.v.map((x, i) => x + dvVec[i]);
  return dv;
}

// ── orbit operations ────────────────────────────────────────────────────────
function orbitPath(sim, endT, burn = null) {
  // propagate the actual state; optional burn {t (sim s), dv RTN m/s}
  let r = sim.r.slice(), v = sim.v.slice(), t = sim.t;
  const T = [], R = [], V = [];
  const push = () => { T.push(t + G.offset); R.push(r[0] / 1000, r[1] / 1000, r[2] / 1000); V.push(v[0] / 1000, v[1] / 1000, v[2] / 1000); };
  push();
  let burned = !burn;
  while (t < endT) {
    let h = Math.min(30, endT - t);
    if (!burned && t + h >= burn.t) h = Math.max(1e-3, burn.t - t);
    [r, v] = rk4Coast(r, v, h, 0);
    t += h;
    if (!burned && t >= burn.t - 1e-6) {
      const [R0, T0, N0] = rtnBasis(r, v);
      v = v.map((x, i) => x + burn.dv[0] * R0[i] + burn.dv[1] * T0[i] + burn.dv[2] * N0[i]);
      burned = true;
    }
    push();
  }
  return new Path(Float64Array.from(T), Float64Array.from(R), Float64Array.from(V));
}

function opsRescreen() {
  const sim = G.sim, p = G.plan;
  const endT = p.horizon;
  const path = orbitPath(sim, endT, G.ops.burn);
  const res = screen(p.eph, path, { tMin: G.offset + sim.t });
  res.path = path;
  G.watch = { res, rows: conjunctions(p.eph, res) };
  G.ops.path = path;
  renderOps();
}

function enterOrbitOps() {
  const sim = G.sim;
  if (G.ops || sim.phase !== 'ORBIT') return;
  if (G.chosen.dv && !G.phasingDone) {
    const dv = impulse(sim, unit(sim.v).map((x) => x * G.chosen.dv));
    G.phasingDone = true;
    hud.event({ t: sim.t, label: 'Phasing burn', detail: `${G.chosen.dv > 0 ? '+' : ''}${dv.toFixed(2)} m/s along-track` });
  }
  G.ops = { burn: null, sel: null };
  $('ops').classList.remove('hidden');
  $('hud-events').classList.add('hidden'); document.querySelector('.hud-right').classList.add('hidden');
  $('ops-sub').textContent = `screening until T+${clock(G.plan.horizon)}`;
  opsRescreen();
  setCam('map');
  G.warpWanted = Math.max(G.warpWanted, 25);
}

function renderOps() {
  const sim = G.sim, now = G.offset + sim.t;
  const rows = G.watch.rows.filter((c) => c.tca > now);
  if (!G.ops.sel || !rows.find((c) => c.i === G.ops.sel)) G.ops.sel = rows.find((c) => c.risk !== 'GREEN')?.i ?? rows[0]?.i ?? null;
  $('ops-conj').innerHTML = rows.length ? rows.slice(0, 8).map((c) => `<div class="cj ${c.i === G.ops.sel ? 'sel' : ''}" data-i="${c.i}">
      <span class="n">${c.name}</span><span class="pill ${c.risk}">${c.risk}</span>
      <span class="m">miss ${fmt(c.miss, 2)} km · Pc ${pcFmt(c.pc)} · ${fmt(c.relSpeed, 1)} km/s · in ${clock(c.tca - now)}</span></div>`).join('')
    : '<div class="muted">No conjunctions within 25 km for the rest of the screening horizon.</div>';
  document.querySelectorAll('.cj').forEach((el) => el.onclick = () => { G.ops.sel = +el.dataset.i; renderOps(); previewBurn(); });
  const b = G.ops.burn;
  $('btn-mv-exec').querySelector('b').textContent = b ? `Burn scheduled in ${clock(b.t - sim.t)} (cancel)` : 'Schedule burn';
  // globe
  views.clearGlobeLayer();
  views.line(G.ops.path, 0x38e1ff, 0.9);
  const st = new Float64Array(6);
  for (const c of rows.slice(0, 10)) {
    G.plan.eph.state(c.i, c.tca, st);
    views.marker([st[0], st[1], st[2]], c.risk === 'RED' ? 0xff4d5e : c.risk === 'AMBER' ? 0xffb547 : 0x3ee38c, c.i === G.ops.sel ? 0.09 : 0.05);
  }
}

function burnFromSliders() {
  const sel = G.watch.rows.find((c) => c.i === G.ops.sel);
  const lead = +$('mv-lead').value * 60;
  const tca = sel ? sel.tca - G.offset : G.sim.t + lead + 60;
  const t = Math.max(G.sim.t + 20, tca - lead);
  $('v-lead').textContent = `${$('mv-lead').value} min`;
  $('v-pro').textContent = `${(+$('mv-pro').value).toFixed(1)} m/s`; $('v-rad').textContent = `${(+$('mv-rad').value).toFixed(1)} m/s`; $('v-nor').textContent = `${(+$('mv-nor').value).toFixed(1)} m/s`;
  return { t, dv: [+$('mv-rad').value, +$('mv-pro').value, +$('mv-nor').value] };
}

function evalBurn(burn) {
  const path = orbitPath(G.sim, G.plan.horizon, burn);
  const res = screen(G.plan.eph, path, { tMin: G.offset + G.sim.t });
  return { res, rows: conjunctions(G.plan.eph, res), sum: summarize(res), dv: norm(burn.dv) };
}

let previewTimer = 0;
function previewBurn() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!G.ops) return;
    const burn = burnFromSliders();
    const e = evalBurn(burn);
    const sel = e.rows.find((c) => c.i === G.ops.sel);
    const avail = G.sim.deltaVLeft();
    $('mv-preview').innerHTML = `Burn at T+${clock(burn.t)} · Δv ${e.dv.toFixed(2)} m/s <span class="muted">(${fmt(avail)} m/s available)</span><br>
      ${sel ? `Selected object → miss <b>${fmt(sel.miss, 2)} km</b>, Pc ${pcFmt(sel.pc)}<br>` : 'Selected object → beyond 25 km<br>'}
      Whole catalog → ${e.sum.red} RED · ${e.sum.amber} AMBER · closest ${fmt(e.sum.minMiss, 2)} km`;
  }, 120);
}
for (const id of ['mv-lead', 'mv-pro', 'mv-rad', 'mv-nor']) $(id).addEventListener('input', previewBurn);

$('btn-mv-exec').onclick = () => {
  if (G.ops.burn) { G.ops.burn = null; opsRescreen(); toast('Burn cancelled'); return; }
  const burn = burnFromSliders();
  if (norm(burn.dv) < 0.05) return toast('Set a Δv first (or ask Sentinel).');
  G.ops.burn = burn;
  opsRescreen();
  toast(`Burn scheduled for T+${clock(burn.t)}`);
};

$('btn-mv-ai').onclick = async () => {
  $('mv-preview').innerHTML = '<span class="muted">Sentinel is searching burn directions and magnitudes…</span>';
  await tick();
  const sel = G.watch.rows.find((c) => c.i === G.ops.sel);
  if (!sel) return;
  // candidate objects: anything within 150 km on the current path (a burn can create new conjunctions)
  const base = G.watch.res;
  const objs = Array.from(base.index).filter((i, q) => base.miss[q] < 150);
  let best = null;
  for (const leadMin of [10, 20, 30, 45]) {
    const t = sel.tca - G.offset - leadMin * 60;
    if (t < G.sim.t + 20) continue;
    for (const dir of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      for (const mag of [0.1, 0.2, 0.4, 0.7, 1, 1.5, 2.5, 4, 6, 8, 10]) {
        const burn = { t, dv: dir.map((x) => x * mag) };
        const path = orbitPath(G.sim, G.plan.horizon, burn);
        const res = screen(G.plan.eph, path, { tMin: G.offset + G.sim.t, objects: objs });
        const s = summarize(res);
        const cost = (s.red ? 1e4 * s.red : 0) + (s.amber ? 50 * s.amber : 0) + 10 * mag + leadMin * 0.01;
        if (!best || cost < best.cost) best = { cost, burn, leadMin, mag, dir };
        if (!s.red && !s.amber) break;   // smallest clean magnitude in this direction
      }
    }
    await tick();
  }
  if (!best) return;
  const full = evalBurn(best.burn);   // verification against the whole catalog
  $('mv-lead').value = best.leadMin; $('mv-pro').value = best.burn.dv[1]; $('mv-rad').value = best.burn.dv[0]; $('mv-nor').value = best.burn.dv[2];
  previewBurn();
  toast(full.sum.red ? 'Sentinel: no burn in range clears every RED. This is the best risk reduction.' : `Sentinel: ${best.mag} m/s ${['radial', 'prograde', 'normal'][best.dir.findIndex((x) => x)]}${best.dir.some((x) => x < 0) ? ' (negative)' : ''}, ${best.leadMin} min before TCA. Verified.`, 4200);
};

$('btn-dispose').onclick = () => {
  const sim = G.sim;
  if (G.disposed) return;
  if (sim.payloadAttached) { sim.payloadAttached = false; hud.event({ t: sim.t, label: 'Payload separation', detail: `${fmt(sim.payload)} kg delivered` }, 'good'); audio.say('Payload separation'); }
  const el = elements(sim.r, sim.v), r = norm(sim.r), rp = RE + 90e3;
  const need = circularSpeed(r) - Math.sqrt(MU * (2 / r - 2 / (r + rp)));
  if (sim.deltaVLeft(true) >= need && sim.prop[sim.stage] > 0) {
    impulse(sim, unit(sim.v).map((x) => -x * need));
    const e2 = elements(sim.r, sim.v);
    G.disposed = true;
    hud.event({ t: sim.t, label: 'De-orbit burn', detail: `−${need.toFixed(0)} m/s, perigee ${(e2.periAlt / 1000).toFixed(0)} km: the stage re-enters within one orbit` }, 'good');
    hud.callout('STAGE DISPOSED', 'controlled re-entry, nothing left behind');
    audio.say('Deorbit burn complete');
  } else {
    hud.event({ t: sim.t, label: 'Cannot de-orbit', detail: `needs ${need.toFixed(0)} m/s, only ${sim.deltaVLeft().toFixed(0)} m/s left: stage stays in a ${(el.periAlt / 1000).toFixed(0)} km orbit` }, 'bad');
    G.disposed = false;
    G.leftInOrbit = true;
  }
  $('btn-dispose').disabled = true;
};
$('btn-end').onclick = () => finishMission();

function fireFragmentation() {
  const sim = G.sim, f = G.fragDue, p = G.plan;
  f.fired = true;
  const path = orbitPath(sim, p.horizon, G.ops?.burn);
  const parents = p.eph.meta.filter((m) => m.type === 'ROCKET BODY');
  const parent = parents.length ? parents[Math.floor(Math.random() * parents.length)].name : 'UNKNOWN OBJECT';
  const tA = G.offset + sim.t + f.afterMin * 60 - 60, tB = G.offset + sim.t + f.afterMin * 60 + 120;
  if (tB > G.offset + p.horizon) return;
  p.eph = injectThreats(p.eph, path, rng(Date.now() & 0xffff), f.events, { tA, tB, cloudProb: 1, parent, idStart: -1000 });
  hud.callout('FRAGMENTATION EVENT', `${parent} has broken up. Debris crosses your orbit in ~${f.afterMin} min`, 5000);
  hud.event({ t: sim.t, label: `Fragmentation: ${parent}`, detail: 'new debris cloud on a crossing orbit' }, 'bad');
  audio.say('Warning. Fragmentation event detected');
  G.warpWanted = Math.min(G.warpWanted, 10);
  opsRescreen();
}

// close approaches: live distance near TCA, outcome drawn from the collision probability
function trackApproaches() {
  const sim = G.sim, now = G.offset + sim.t;
  const st = new Float64Array(6);
  let near = null;
  for (const c of G.watch.rows) {
    if (G.resolved.has(c.i)) continue;
    if (c.risk === 'GREEN' && c.tca < now) { G.resolved.add(c.i); continue; }
    if (c.risk === 'GREEN') continue;
    const dt = c.tca - now;
    if (dt < 120 && dt > -2) near = c;
    if (dt <= -1) {
      G.resolved.add(c.i);
      const hit = Math.random() < c.pc;
      G.passes.push({ name: c.name, miss: c.miss, pc: c.pc, risk: c.risk, hit });
      if (hit) {
        G.collision = c.name;
        sim.fail('collision', 'Collision', `with ${c.name} at ${fmt(c.relSpeed, 1)} km/s (Pc was ${pcFmt(c.pc)})`);
      } else hud.event({ t: sim.t, label: `Close approach: ${c.name}`, detail: `${fmt(c.miss, 2)} km, Pc ${pcFmt(c.pc)}` }, c.risk === 'RED' ? 'bad' : '');
    }
  }
  G.closeApproach = !!near;
  const box = $('ca-alert');
  if (near) {
    G.plan.eph.state(near.i, now, st);
    const d = Math.hypot(st[0] - sim.r[0] / 1000, st[1] - sim.r[1] / 1000, st[2] - sim.r[2] / 1000);
    box.innerHTML = `<b>${near.risk} CONJUNCTION</b>${near.name} · range ${fmt(d, 2)} km · TCA in ${Math.max(0, near.tca - now).toFixed(1)} s<br>predicted miss ${fmt(near.miss, 3)} km · Pc ${pcFmt(near.pc)}`;
    box.classList.remove('hidden');

  } else box.classList.add('hidden');
}

function finishMission() {
  if (G.ended) return;
  G.ended = true;
  const sim = G.sim, c = G.plan.cfg, m = G.mission;
  const orbit = !!sim.insertion;
  const r = { orbit, el: sim.insertion?.el, targetAlt: c.targetAltKm, targetInc: c.targetIncDeg, conj: G.passes, collision: G.collision,
    avoidDv: G.avoidDv, slip: G.chosen.slip, disposed: G.disposed, maxQ: sim.maxQ, qLimit: c.vehicle.qLimit, dvLeft: sim.insertion?.dvLeft ?? 0,
    failure: sim.failure ? `${sim.failure.label}: ${sim.failure.detail}` : null };
  const sc = scoreMission(r);
  if (m) saveResult(m.id, sc.stars, sc.total);
  $('deb-title').textContent = sc.verdict;
  $('deb-stars').innerHTML = `${'★'.repeat(sc.stars)}<span class="off">${'★'.repeat(3 - sc.stars)}</span>`;
  $('deb-score').innerHTML = sc.rows.map(([k, v]) => `<tr><td>${k}</td><td>${v > 0 ? '+' : ''}${v}</td></tr>`).join('') + `<tr class="total"><td>Total</td><td>${sc.total}</td></tr>`;
  const el = sim.insertion?.el;
  $('deb-flight').innerHTML = [
    ['Vehicle', `${c.vehicle.name}`], ['Lift-off', fmtUTC(sim.T0)], ['Pitch kick', `${sim.cfg.kickDeg.toFixed(1)}°`],
    ['Max-Q', `${fmt(sim.maxQ / 1000, 1)} kPa at T+${fmt(sim.maxQAt)} s`], ['Max acceleration', `${fmt(sim.maxG, 2)} g`],
    ['Insertion', el ? `${fmt(el.apoAlt / 1000, 1)} × ${fmt(el.periAlt / 1000, 1)} km, ${fmt(el.incDeg, 2)}°` : '—'],
    ['Insertion time', sim.insertion ? `T+${clock(sim.insertion.t)}` : '—'],
    ['Conjunctions flown', G.passes.length ? G.passes.map((p) => `${p.name} ${fmt(p.miss, 2)} km`).join(', ') : 'none'],
    ['Spent stages', sim.spent.filter((s) => s.impact).map((s) => `${s.name} ${fmt(s.impact.downrange)} km`).join(', ') || '—'],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  const L = sim.losses, delivered = L.ideal - L.gravity - L.drag - L.steering;
  $('deb-loss').innerHTML = [['Ideal Δv burned', L.ideal], ['Gravity loss', L.gravity], ['Drag loss', L.drag], ['Steering loss', L.steering], ['Speed gained', delivered]]
    .map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)} m/s</td></tr>`).join('');
  const cv = $('deb-dv'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const bars = [['ideal', L.ideal, '#38e1ff'], ['gravity', L.gravity, '#ff4d5e'], ['drag', L.drag, '#ffb547'], ['steering', L.steering, '#a78bfa'], ['gained', delivered, '#3ee38c']];
  const mx = Math.max(...bars.map((b) => b[1]), 1);
  bars.forEach(([k, v, col], i) => {
    const w = 52, x = 16 + i * 68, h = (v / mx) * 130;
    g.fillStyle = col; g.fillRect(x, 150 - h, w, h);
    g.fillStyle = '#8696ad'; g.font = '11px JetBrains Mono'; g.fillText(k, x, 166); g.fillText(fmt(v), x, 145 - h);
  });
  const idx = m ? MISSIONS.indexOf(m) : -1;
  $('btn-next').querySelector('b').textContent = m && idx < MISSIONS.length - 1 && sc.stars ? 'Next mission' : 'Campaign';
  $('btn-next').onclick = () => { if (m && idx < MISSIONS.length - 1 && sc.stars) openHangar(MISSIONS[idx + 1]); else show('campaign'); };
  views.mode = 'globe';
  show('debrief');
}

// ── main loop ───────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  G.frame++;
  if (G.screen === 'flight' && G.sim && !G.ended) stepFlight(dt);
  else if (G.screen !== 'flight') {
    G.titleTime = (G.titleTime || Date.now()) + dt * 120 * 1000;
    views.updateGlobe(new Date(G.titleTime));
  }
  views.render(dt);
  requestAnimationFrame(frame);
}

function stepFlight(dt) {
  const sim = G.sim;
  if (G.paused) return;
  if (sim.phase === 'PAD') {
    const before = Math.ceil(G.countdown);
    G.countdown -= dt;
    const after = Math.ceil(G.countdown);
    if (after !== before && after > 0 && after <= 9) { audio.say(String(after)); audio.beep(660); }
    $('hud-tminus').textContent = 'T−';
    $('hud-clock').textContent = clock(Math.max(0, G.countdown));
    $('hud-phase').textContent = 'TERMINAL COUNT';
    if (G.countdown <= 0) { sim.liftoff(); $('hud-tminus').textContent = 'T+'; }
    sim._telemetry(sim.environment(sim.r, sim.v), 0, sim.att, sim.mass());
  } else {
    applySteeringKeys(sim, dt);
    G.warp = Math.min(G.warpWanted, warpCap());
    const simDt = dt * G.warp;
    const prevT = sim.t;
    if (sim.phase !== 'FAILED') sim.advance(simDt, G.warp <= 2 ? 0.02 : 0.05);
    // scheduled avoidance burn
    if (G.ops?.burn && sim.t >= G.ops.burn.t) {
      const b = G.ops.burn;
      const [R0, T0, N0] = rtnBasis(sim.r, sim.v);
      const dvVec = [0, 1, 2].map((i) => b.dv[0] * R0[i] + b.dv[1] * T0[i] + b.dv[2] * N0[i]);
      const got = impulse(sim, dvVec);
      G.avoidDv += got;
      hud.event({ t: sim.t, label: 'Avoidance burn', detail: `${got.toFixed(2)} m/s (R ${b.dv[0]}, T ${b.dv[1]}, N ${b.dv[2]})` }, 'good');
      hud.callout('AVOIDANCE BURN', `${got.toFixed(2)} m/s`);
      audio.say('Avoidance burn');
      G.ops.burn = null;
      opsRescreen();
    }
    if (G.fragDue && !G.fragDue.fired && G.ops && sim.t > sim.insertion.t + 90) fireFragmentation();
    if (sim.phase !== 'FAILED') trackApproaches();
    if (G.ops && G.frame % 30 === 0) renderOps();
    if (G.ops && sim.t >= G.plan.horizon && !G.horizonWarned) { G.horizonWarned = true; G.warpWanted = 1; toast('End of the screening horizon: deploy the payload, dispose of the stage, then end the mission.', 6000); }
    $('hud-tminus').textContent = 'T+';
    $('hud-clock').textContent = clock(sim.t);
    $('hud-phase').textContent = sim.phase === 'ORBIT' ? 'ORBIT OPERATIONS' : sim.phase === 'FAILED' ? (sim.failure?.label || 'FAILED').toUpperCase() : sim.mode.replace(/_/g, ' ');
    if (G.frame % 20 === 0) G.trail.push(sim.r.slice());
    const env = sim.environment(sim.r, sim.v);
    const thrust = sim.thrustAt(sim.engines(), env.atm.p);
    audio.update(thrust, env.atm.p / 101325, G.warp);
  }
  hud.update(sim, G.warp, G.frame, G.warpWanted);
  if (views.mode === 'local') views.updateLocal(sim, performance.now() / 1000);
  else {
    views.updateGlobe(sim.date);
    views.vehMarker.visible = true;
    views.vehMarker.position.copy(toThree(sim.r, 1e-6));
    if (G.frame % 15 === 0 && !G.ops) {
      views.clearGlobeLayer();
      if (G.trail.length > 1) views.line(G.trail.map((p) => p.map((x) => x / 1000)), 0xffb547, 0.9);
      if (sim.phase !== 'PAD') {
        const pr = propagate(sim.r, sim.v, Math.min(elements(sim.r, sim.v).period || 5400, 7000), 60, 30);
        const pts = []; for (let i = 0; i < pr.t.length; i++) pts.push([pr.r[3 * i] / 1000, pr.r[3 * i + 1] / 1000, pr.r[3 * i + 2] / 1000]);
        views.line(pts, 0x38e1ff, 0.5, true);
      }
    }
  }
  if (views.mode !== 'globe') views.vehMarker.visible = false;
}

// ── manual ──────────────────────────────────────────────────────────────────
function renderManual() {
  $('manual').innerHTML = `
  <section><h3>The idea</h3><p>SentinelFlight puts you in charge of a real launch into the real sky. The catalog is the public space-object catalog (Space-Track / CelesTrak), refreshed automatically on the server. Every object is propagated with SGP4 in your browser, and your rocket is integrated numerically from the pad to orbit.</p></section>
  <section><h3>Mission flow</h3><p><b>Setup</b>: pick vehicle, site, orbit, payload and lift-off time. <b>Pre-flight</b>: the flight computer searches for the most efficient pitch-over, then every catalog object is propagated and screened against your trajectory. <b>Launch COLA</b>: the launch-window chart shows the closest approach for every possible lift-off minute; choose a clear one, or ask Sentinel. <b>Flight</b>: watch or fly the ascent. <b>Orbit operations</b>: dodge conjunctions with small burns, then deploy the payload and de-orbit the stage.</p></section>
  <section><h3>Controls</h3><p><kbd>Space</kbd> skip the count / stage manually · <kbd>W</kbd><kbd>S</kbd> pitch offset · <kbd>A</kbd><kbd>D</kbd> yaw offset · <kbd>R</kbd> centre the stick · <kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>X</kbd> cut liquid engines · <kbd>Z</kbd> full throttle · <kbd>T</kbd> hand everything back to the autopilot · <kbd>,</kbd> <kbd>.</kbd> time warp · <kbd>C</kbd> camera · <kbd>M</kbd> map · <kbd>P</kbd> pause · <kbd>N</kbd> sound. Drag to orbit the camera, scroll to zoom.</p></section>
  <section><h3>Physics of the rocket</h3><p>Gravity with Earth's J2 oblateness; drag in the U.S. Standard Atmosphere 1976 with a Mach-dependent drag coefficient, relative to the rotating air; thrust that rises with altitude as back-pressure on the nozzle falls (F = F<sub>vac</sub> − (F<sub>vac</sub> − F<sub>sl</sub>)·p/p₀); constant mass flow from the vacuum specific impulse. RK4 integration, with steps cut exactly at burnout. Vehicles use approximate public figures for stage masses, thrust and Isp.</p></section>
  <section><h3>Guidance</h3><p>Vertical rise, a pitch kick toward the launch azimuth (corrected for Earth's rotation), a zero-angle-of-attack gravity turn while throttling for max-Q, then closed-loop vacuum guidance into a 200 km × target transfer orbit and a circularisation burn at apoapsis. Steering hard through max-Q breaks the vehicle (q·α limit). Solid motors cannot be throttled or shut down.</p></section>
  <section><h3>Collision risk</h3><p>Probability of collision uses a 2-D Gaussian in the encounter plane. Each object's uncertainty grows with the age of its element set, using a model fitted to a back-test of SGP4 against the next element set (artifacts/). RED means Pc ≥ 1e-4 (the NASA CARA maneuver threshold) or a miss under 1 km; AMBER means Pc ≥ 1e-6 or under 5 km. When you fly through a conjunction, the outcome is drawn from its Pc: a 1-in-1000 risk really is one in a thousand.</p></section>
  <section><h3>Sentinel</h3><p>Before launch, Sentinel is the Double DQN agent trained in this repository (src/rl), running in your browser with exactly the same state, actions and reward. Its plan is always re-screened; if anything is still RED, a guard falls back to an exhaustive one-step search. In orbit, Sentinel searches burn direction, size and timing, then verifies the best burn against the whole catalog.</p></section>
  <section><h3>Scoring</h3><p>Orbit +1000 · insertion accuracy up to +500 · inclination up to +200 · no RED conjunctions +600 (−400 each) · AMBER −60 each · avoidance Δv −25 per m/s · launch slip −1 per 10 s · max-Q discipline +100 · propellant margin up to +300 · upper stage de-orbited +400 (left in orbit −150) · collision −2000. Stars: orbit; safe and accurate; and a clean, disposed, high-scoring flight.</p></section>
  <section><h3>Honest limits</h3><p>Public TLEs have no covariance, so uncertainty is isotropic. Vehicle figures are approximate. Without Space-Track credentials the server falls back to CelesTrak's public groups, which omit most rocket bodies and small debris; the data badge says when that is the case.</p></section>`;
}

show('title', false);
addEventListener('resize', () => views.setGlobeShift(G.screen === 'title' ? 0.2 : 0));
boot();
requestAnimationFrame(frame);
