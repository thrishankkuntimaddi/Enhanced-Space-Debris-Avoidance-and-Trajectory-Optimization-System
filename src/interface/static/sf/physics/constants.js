// Physical constants. SI units (m, s, kg) inside the flight simulator; km for orbits/screening
// to match SGP4. Earth model: WGS-84 / EGM-96 (J2) for the vehicle; SGP4 carries its own WGS-72.
export const MU = 3.986004418e14;          // m^3/s^2
export const MU_KM = 398600.4418;          // km^3/s^2
export const RE = 6378137.0;               // m, equatorial radius
export const RE_KM = 6378.137;
export const FLATTENING = 1 / 298.257223563;
export const J2 = 1.08262668e-3;
export const OMEGA_E = 7.292115146706979e-5; // rad/s, sidereal rotation
export const G0 = 9.80665;                 // m/s^2, standard gravity (defines Isp)
export const DEG = Math.PI / 180;
export const TWO_PI = 2 * Math.PI;

// Conjunction thresholds: identical to src/config/settings.py so the Python planner, the
// trained agent and the game all judge risk the same way.
export const PC_RED = 1e-4;               // NASA CARA maneuver threshold
export const PC_AMBER = 1e-6;
export const MISS_RED_KM = 1.0;
export const MISS_AMBER_KM = 5.0;
export const REPORT_KM = 25.0;
export const MISSION_SIGMA_KM = 0.25;     // our own vehicle's 1-sigma position uncertainty
export const SIGMA0_KM = 0.05;            // debris sigma(age) = SIGMA0 + K * age (back-tested, artifacts/)
export const SIGMA_K_KM_PER_DAY = 0.6074;
export const DALT_MAX_KM = 10, DV_MAX_MS = 3, DV_BUDGET_MS = 10;
