// SGP4 worker: propagates a slice of the catalog on a common time grid and keeps only the objects
// that can come near the vehicle. SGP4 = satellite.js (Vallado's reference implementation ported
// to JavaScript); the page cross-checks it against python-sgp4 on the server (/api/sgp4-check).
import * as satellite from 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.es.js';
import { minDistanceToPaths, sigmaForAge } from '../physics/collision.js';

self.onmessage = (ev) => {
  const { job, rows, epochMs, dt, steps, paths, keepKm, launchMs } = ev.data;
  const n = rows.length;
  const pos = new Float32Array(n * steps * 3), vel = new Float32Array(n * steps * 3), ok = new Uint8Array(n * steps);
  const jd0 = epochMs / 86400000 + 2440587.5;
  let failed = 0;
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    let rec;
    try { rec = satellite.twoline2satrec(row[9], row[10]); } catch { failed++; continue; }
    const base = i * steps;
    for (let k = 0; k < steps; k++) {
      const tsince = (jd0 - rec.jdsatepoch) * 1440 + (k * dt) / 60;
      const pv = satellite.sgp4(rec, tsince);
      if (!pv || !pv.position) continue;
      const o = (base + k) * 3, p = pv.position, v = pv.velocity;
      pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z;
      vel[o] = v.x; vel[o + 1] = v.y; vel[o + 2] = v.z;
      ok[base + k] = 1;
    }
    if (i % 250 === 0) self.postMessage({ job, progress: i / n });
  }
  // prune: keep objects that pass within keepKm of the vehicle for any allowed slip
  const keep = [];
  for (let i = 0; i < n; i++) if (minDistanceToPaths(pos, ok, steps, i, paths) < keepKm) keep.push(i);
  const m = keep.length;
  const kp = new Float32Array(m * steps * 3), kv = new Float32Array(m * steps * 3), kok = new Uint8Array(m * steps);
  const meta = [];
  keep.forEach((i, q) => {
    kp.set(pos.subarray(i * steps * 3, (i + 1) * steps * 3), q * steps * 3);
    kv.set(vel.subarray(i * steps * 3, (i + 1) * steps * 3), q * steps * 3);
    kok.set(ok.subarray(i * steps, (i + 1) * steps), q * steps);
    const r = rows[i];
    const ageDays = (launchMs - Date.parse(r[8] + 'Z')) / 86400000;
    meta.push({ id: r[0], name: r[1], type: r[2], owner: r[3], hbr: r[4], sigma: sigmaForAge(ageDays), ageDays, l1: r[9], l2: r[10] });
  });
  self.postMessage({ job, done: true, n: m, epochMs, dt, steps, pos: kp, vel: kv, ok: kok, meta, scanned: n, failed },
    [kp.buffer, kv.buffer, kok.buffer]);
};
