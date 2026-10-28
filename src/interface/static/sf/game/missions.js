// Campaign, scoring and saved progress.
export const MISSIONS = [
  { id: 'first-light', n: 1, name: 'First Light', vehicle: 'electron', site: 'MAHIA', alt: 500, inc: 45, payload: 150, window: 600, offsetH: 6,
    difficulty: 'Training',
    brief: 'Your first orbit. Electron lifts off from Māhia on nine Rutherford engines. Its second stage leaves you on a transfer ellipse, and the tiny Curie kick stage circularises at apoapsis. Watch max-Q, staging and the circularisation burn.',
    objectives: ['Reach orbit', 'Altitude within 3 %', 'No RED conjunction'] },
  { id: 'the-shell', n: 2, name: 'The Shell', vehicle: 'falcon9', site: 'SLC40', alt: 550, inc: 53, payload: 8000, window: 600, offsetH: 9,
    difficulty: 'Standard',
    brief: 'Deliver 8 t into the busiest shell in orbit: 53°, 550 km, home to thousands of Starlink satellites. Use the launch-window chart to find a lift-off time that stays clear of every one.',
    objectives: ['Clean launch (no AMBER)', 'Altitude within 2 %', 'Dispose of the upper stage'] },
  { id: 'korolev', n: 3, name: "Korolev's Cross", vehicle: 'soyuz', site: 'BAIKONUR', alt: 420, inc: 51.6, payload: 4000, window: 300, offsetH: 14,
    difficulty: 'Standard',
    brief: 'Fly the oldest rocket design still flying into the International Space Station\'s orbital plane. The four strap-ons fall away in the famous cross; Fregat finishes the job. Keep well clear of the station and its neighbours.',
    objectives: ['Reach orbit', 'Stay > 5 km from every object', 'Altitude within 2 %'] },
  { id: 'sso', n: 4, name: 'Sun-Synchronous', vehicle: 'pslv', site: 'SHAR', alt: 700, inc: 98.2, payload: 1500, window: 300, offsetH: 20,
    difficulty: 'Hard', fragmentation: { events: 1, afterMin: 20 },
    brief: 'PSLV-XL flies south from Sriharikota into a retrograde, sun-synchronous orbit. Its solid stages cannot be throttled: you cannot soften max-Q. Expect a fragmentation alert after insertion.',
    objectives: ['Reach orbit', 'Survive the fragmentation event', 'Altitude within 2 %'] },
  { id: 'zero-window', n: 5, name: 'Zero Window', vehicle: 'ariane64', site: 'KOUROU', alt: 800, inc: 6, payload: 10000, window: 0, offsetH: 26,
    difficulty: 'Hard', threats: 3, seed: 11,
    brief: 'An instantaneous launch window: you cannot slip lift-off by even a second. Three debris events cross the nominal trajectory. Your only tools are the insertion altitude and a phasing burn.',
    objectives: ['No RED conjunction', 'Δv spent on avoidance < 4 m/s', 'Altitude within 2 %'] },
  { id: 'heavy-weather', n: 6, name: 'Heavy Weather', vehicle: 'falconheavy', site: 'LC39A', alt: 600, inc: 28.6, payload: 20000, window: 600, offsetH: 32,
    difficulty: 'Expert', threats: 2, seed: 5, fragmentation: { events: 2, afterMin: 15 },
    brief: 'Twenty tonnes on three cores. Two debris events threaten the ascent, and after insertion a breakup will throw a fragment cloud across your orbit. Plan, fly, dodge, and leave nothing behind.',
    objectives: ['No collision', 'No RED conjunction at any time', 'Dispose of the upper stage'] },
];

const KEY = 'sentinelflight.progress.v1';
export function loadProgress() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveResult(id, stars, score) {
  try {
    const p = loadProgress();
    const best = p[id] || { stars: 0, score: 0 };
    p[id] = { stars: Math.max(best.stars, stars), score: Math.max(best.score, score) };
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch { /* private window: progress just isn't kept */ }
}
export function unlocked(i) {
  if (i === 0) return true;
  const p = loadProgress();
  return (p[MISSIONS[i - 1].id]?.stars || 0) >= 1;
}

/** Score a finished mission. r: { orbit, el, targetAlt, targetInc, conj (passes), collision, avoidDv, slip,
 *  disposed, maxQ, qLimit, dvLeft, mission } */
export function scoreMission(r) {
  const rows = [];
  let total = 0;
  const add = (label, pts) => { rows.push([label, Math.round(pts)]); total += pts; };
  if (!r.orbit) {
    add('Orbit not achieved', 0);
    return { rows, total: 0, stars: 0, verdict: r.failure || 'Mission lost' };
  }
  add('Orbit achieved', 1000);
  const tol = 0.03 * r.targetAlt;
  const dA = Math.abs(r.el.apoAlt / 1000 - r.targetAlt), dP = Math.abs(r.el.periAlt / 1000 - r.targetAlt);
  const acc = Math.max(0, 1 - (dA + dP) / 2 / tol);
  add(`Insertion accuracy (${(r.el.apoAlt / 1000).toFixed(0)} × ${(r.el.periAlt / 1000).toFixed(0)} km)`, 500 * acc);
  const dI = Math.abs(r.el.incDeg - r.targetInc);
  add(`Inclination (${r.el.incDeg.toFixed(2)}°)`, 200 * Math.max(0, 1 - dI / 0.2));
  if (r.collision) add(`Collision with ${r.collision}`, -2000);
  const red = r.conj.filter((c) => c.risk === 'RED').length, amber = r.conj.filter((c) => c.risk === 'AMBER').length;
  add(red ? `${red} RED conjunction${red > 1 ? 's' : ''} flown through` : 'No RED conjunctions', red ? -400 * red : 600);
  if (amber) add(`${amber} AMBER conjunction${amber > 1 ? 's' : ''}`, -60 * amber);
  if (r.avoidDv > 0) add(`Avoidance Δv (${r.avoidDv.toFixed(1)} m/s)`, -25 * r.avoidDv);
  if (r.slip) add(`Launch slip (${r.slip} s)`, -Math.abs(r.slip) / 10);
  if (r.maxQ < 0.85 * r.qLimit) add('Max-Q discipline', 100);
  add(`Propellant margin (${r.dvLeft.toFixed(0)} m/s)`, Math.min(300, r.dvLeft * 0.3));
  add(r.disposed ? 'Upper stage de-orbited' : 'Upper stage left in orbit', r.disposed ? 400 : -150);
  const safe = !r.collision && red === 0;
  const stars = !r.orbit ? 0 : 1 + (safe && acc > 0.4 ? 1 : 0) + (safe && acc > 0.4 && r.disposed && total > 2200 ? 1 : 0);
  return { rows, total: Math.round(total), stars, verdict: r.collision ? 'Mission lost: collision' : safe ? 'Mission success' : 'Orbit reached with unsafe conjunctions' };
}
