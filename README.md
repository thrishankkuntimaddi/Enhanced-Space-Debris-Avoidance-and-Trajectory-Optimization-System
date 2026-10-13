# SDATOS: Space Debris Avoidance & Trajectory Optimization System

A launch-planning system that checks a planned launch against every tracked object in orbit and, when the trajectory is risky, uses a **Double Deep Q-Network (DDQN)** agent to find the cheapest safe fix: shift the launch time, change the insertion altitude, or add a phasing burn. Each proposed plan is screened again by the physics engine before it is accepted, and the result is shown in a three.js mission console.

```
Space-Track.org ─► 7-day TLE window ─► super dataset ─► SGP4 back-test ─► conjunction screening ─► Double DQN ─► verify ─► report + 3-D
  (daily pulls)      (59.5k elsets)    (23.8k objects)   (σ model)         (Pc per object)          (plan)      (guard)
```

All numbers below come from the scripts in this repo and are committed under [`artifacts/`](artifacts).

---

## 1. Data: from raw TLEs to a "super dataset"

| Stage | Result (seed snapshot, Mar 6–13 2025) |
|---|---|
| Raw element sets parsed (column-level validation + checksum) | 59,557 / 59,557 |
| Exact duplicates · same-epoch republications · outside 7-day window | 2,277 · 6,406 · 14 |
| Element sets kept in history | **50,860** |
| Unique objects (latest elset per object = super dataset) | **23,805** (LEO 20,484 · GEO 1,471 · HEO 1,178 · MEO 672) |
| SATCAT join (names, type, radar cross-section) | 13,346 payloads · 8,323 debris · 1,865 rocket bodies · 271 unknown |
| Elset discontinuities → maneuvering payloads | 503 → 415 (the other 88 are fit noise on debris or rocket bodies, which can't maneuver) |

* `src/data/spacetrack_client.py` handles collection. It logs in to Space-Track (credentials from env vars, throttled to their API policy) and pulls `gp`/`gp_history` as 3LE, with CelesTrak as a fallback. A daily GitHub Action ([`collect-tle.yml`](.github/workflows/collect-tle.yml)) builds up the 7-day window.
* `src/data/tle_pipeline.py` builds the window. For each object it keeps the latest elset and adds features computed from its history: decay rate, staleness, maneuver flags, and hard-body radius from RCS.

## 2. How accurate are the predictions? (back-test)

For each of the 17,160 objects with ≥2 elsets, I propagated the older elset to the newer elset's epoch with SGP4 and measured the difference: **25,840 prediction pairs** in total.

| LEO horizon | median error | p90 | along-track / radial (median) |
|---|---|---|---|
| 0–6 h | **0.11 km** | 3.7 km | 0.10 / 0.011 km |
| 6–12 h | 0.18 km | 5.0 km | 0.17 / 0.025 km |
| 12–24 h | 0.59 km | 13.9 km | 0.58 / 0.045 km |
| 24–48 h | 0.87 km | 11.4 km | 0.87 / 0.073 km |

The error is almost entirely **along-track**, roughly 10× the radial error, which is the expected signature of drag uncertainty. A robust (MAD-based) fit gives **σ(age) = 0.05 km + 0.61 km/day**, and this is used as each object's position uncertainty when computing probability of collision.

![prediction error](artifacts/fig_prediction_error.png)

## 3. Conjunction screening

`src/screening/conjunction.py` works coarse-to-fine:

1. **Altitude-band filter** (perigee/apogee overlap): 23,805 → ~10–14k objects
2. **Vectorized SGP4** (`SatrecArray`) on a 10 s grid that covers every launch time the optimizer might pick
3. **Proximity prune**: keep only objects that come within 120–150 km of any candidate plan, leaving **~1.3–1.9k**
4. **Closed-form TCA**: between samples, relative motion is nearly linear, so the time and distance of closest approach are solved exactly. This is checked against a 1 ms brute force (within 50 m) in `tests/`.
5. **Probability of collision**: 2-D Gaussian in the encounter plane, `Pc = ncx2.cdf((HBR/σ)², 2, (miss/σ)²)`, checked against Monte Carlo in `tests/`. RED means Pc ≥ 1e-4 (NASA CARA maneuver threshold) or miss < 1 km.

Building the context takes ~4–8 s per mission. After that, **re-screening any candidate plan takes ~15–20 ms**, and that is what makes RL practical here.

> **Bug the tests caught.** The first version refined the time of closest approach only around the *nearest sample*. At ~15 km/s relative speed, samples are 150 km apart, so a closer encounter (for example one orbit later) could fall between two distant samples. On a test case the screener reported 1.25 km when the true miss was 0.37 km, which **under-reports risk**. The fix refines every segment for any object that could be hiding an encounter. Both RL models were then retrained on the corrected physics.

## 4. Mission model

`src/physics/mission.py`: the launch site is rotated into the TEME frame using Greenwich sidereal time, so slipping the launch shifts the orbit plane at exactly Earth's rotation rate (tested). The launch azimuth comes from `sin β = cos i / cos φ_geocentric`. Ascent follows a smooth kinematic profile whose speed at insertion matches circular velocity, and after insertion the orbit is propagated as Keplerian. The legacy code compared Earth-fixed rocket positions with inertial (TEME) debris positions, which made every distance meaningless. Everything is now in one frame.

## 5. Double DQN avoidance agent

`src/rl/` frames avoidance as an MDP:

* **Actions (7):** COMMIT · launch slip ±60 s · insertion altitude ±2 km · phasing burn ±0.5 m/s, with masks for the launch window, ±10 km, ±3 m/s and a 10 m/s Δv budget
* **State (48):** current plan, fuel used, launch window and steps left, plus the 5 most dangerous conjunctions (proximity, time to TCA, RTN miss vector, log Pc, relative speed, RED flag)
* **Reward:** potential-based shaping on a risk potential (which leaves the optimal policy unchanged), minus 0.25 per m/s of Δv, 0.1 per minute of slip and 0.02 per step, plus a terminal score for no RED / no AMBER
* **Agent:** Double DQN (online network picks the next action, target network scores it), dueling head, Huber loss, Polyak target updates, action masking. Trained in PyTorch (4,000 episodes, ~8.5 min on a laptop CPU) and exported to **numpy** for serving, so the web app needs no PyTorch (forward pass: 13 µs).
* **Scenarios:** real-catalog background (so an action can *create* new risk, for example climbing into the Starlink shell) plus injected crossings and fragment clouds, and launch windows from instantaneous to ±10 min. Training and test missions are disjoint.

### Held-out results: 200 scenarios, 6 unseen missions (156 have a RED conjunction if nothing is done)

| Policy | Safe (no RED) | Clean (no AMBER) | Δv m/s | Cost ↓ | Screenings / plan | ms / plan |
|---|---|---|---|---|---|---|
| No avoidance | 22.0% | 11.5% | 0 | 5.95 | 1 | 16 |
| Random | 73.0% | 35.0% | 1.17 | 0.75 | 4.9 | 78 |
| Greedy one-step lookahead | 100% | 93.0% | 0.58 | −2.25 | 13.7 | 243 |
| DQN (ablation) | 100% | 79.5% | 0.92 | −2.07 | 3.6 | 84 |
| Double DQN | 99.5% | 82.0% | 0.75 | −2.06 | 4.3 | 85 |
| **Double DQN + verification guard** | **100%** (95% CI 98.1–100) | 82.0% | 0.74 | −2.09 | **5.3** | 82 |
| Grid search (80-scenario subset) | 100% | 100% | 0.57 | −2.28 | 294 | 4,738 |

**What these results support:**
* The guarded DDQN is **100% safe** on held-out missions. It gets **~92% of the brute-force grid's cost improvement with 56× fewer screenings**, and needs 2.6× fewer screenings than greedy search. In a real operations setting, each screening runs a high-fidelity ephemeris against the whole catalog and takes minutes, so the number of screenings is the cost that matters.
* **Greedy lookahead finds better plans** (93% vs 82% clean). Conjunctions are very sharply localized in decision space, so a one-step search almost always finds a fix. The honest value of the learned policy is amortized cost, not better plans.
* **DDQN vs vanilla DQN is a tie here.** With ≤10-step episodes, there is little bootstrapping for overestimation bias to build up in. Both gaps fall to ~0.1–0.15 (see figure).
* The guard (re-screen the committed plan, fall back to greedy if anything is still RED) triggered in 0.5% of cases and turned 99.5% into 100%.

![training](artifacts/fig_training.png)

### Real catalog, no injected threats
Out of 30 random launches against the March 2025 catalog, **11 had an AMBER conjunction and 0 had a RED one** (median closest approach 6.1 km), almost all in the ~540–560 km Starlink shell. Example: **Falcon 9 → 550 km at 2025-03-12 06:00 UTC** passes **STARLINK-2224 at 1.40 km (Pc 1.6e-5)**. The agent's plan was to launch 60 s earlier, which clears every AMBER (new minimum miss 7.7 km) with **0 m/s of extra Δv** and 3 screenings.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-train.txt          # serving only: requirements.txt

python -m src.cli all                          # build super dataset + back-test + figures
python -m src.cli plan --rocket "Falcon 9" --alt 550 --launch 2025-03-12T06:00
python -m src.rl.train --episodes 4000         # Double DQN   (--vanilla for the DQN ablation)
python -m src.rl.evaluate --scenarios 200      # held-out comparison -> artifacts/evaluation.json
python -m pytest -q                            # 15 tests
python run.py                                  # http://127.0.0.1:5000  (console + /evidence)

export SPACETRACK_USERNAME=... SPACETRACK_PASSWORD=...
python -m src.cli fetch --history              # pull a fresh 7-day history from Space-Track
```

## Layout

```
src/data/        spacetrack_client.py · tle_pipeline.py · propagation_validation.py
src/physics/     frames.py (TEME/GMST/RTN) · mission.py (ascent + Kepler, maneuver plan)
src/screening/   conjunction.py (filters, vectorized SGP4, TCA, Pc)
src/rl/          env.py · scenarios.py · ddqn.py · policies.py · train.py · evaluate.py
src/pipeline/    planner.py (end-to-end) · src/reporting/figures.py · src/cli.py
src/interface/   Flask app, three.js console, report + evidence pages
artifacts/       committed metrics & figures      models/ddqn_policy.npz  serving weights
legacy/          the pre-rebuild implementation (kept for comparison)
```

## Limits (on purpose)
* Public TLEs come without covariance, so σ is isotropic and comes from our own back-test. Operational collision assessment uses special-perturbation ephemerides and full covariance.
* The ascent is kinematic and the post-insertion orbit is two-body over a ~2.5 h horizon (no drag or J2).
* This is a decision-support prototype, not a launch-COLA system of record.
