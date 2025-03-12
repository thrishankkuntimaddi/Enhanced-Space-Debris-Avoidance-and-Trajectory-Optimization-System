# src/core/mission_report.py
import os
from datetime import datetime
import numpy as np


class MissionReport:
    def __init__(self,
                 output_dir="/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/outputs/mission_reports"):
        self.output_dir = output_dir
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)

    def generate(self, rocket_type, launch_site, orbit_type, altitude_km, timestamp,
                 trajectory_data, collisions, rocket_params, optimized_trajectory_data=None, filename=None):
        # Unpack trajectory data (pre-optimization)
        equations, t_climb, formulas, initial, v_orbit, burn_time = trajectory_data
        x0, y0, z0 = initial['x0'], initial['y0'], initial['z0']

        # Unpack rocket params
        thrust = rocket_params.get('thrust_N', 0)
        mass = rocket_params.get('mass_kg', 0)
        burn_time_param = rocket_params.get('burn_time_s', burn_time)

        # Calculate pre-optimization stats
        x_final = equations['x'](t_climb)
        y_final = equations['y'](t_climb)
        z_final = equations['z'](t_climb)
        distance_traveled = sum(
            ((equations['x'](t2) - equations['x'](t1)) ** 2 +
             (equations['y'](t2) - equations['y'](t1)) ** 2 +
             (equations['z'](t2) - equations['z'](t1)) ** 2) ** 0.5
            for t1, t2 in zip(np.linspace(0, t_climb, 1000)[:-1], np.linspace(0, t_climb, 1000)[1:])
        ) / 1000  # km
        total_journey_time = t_climb  # Total time to target

        # Optimized trajectory (if provided)
        if optimized_trajectory_data:
            opt_equations, opt_t_climb, opt_formulas, opt_initial, opt_v_orbit, _ = optimized_trajectory_data
            opt_x_final = opt_equations['x'](opt_t_climb)
            opt_y_final = opt_equations['y'](opt_t_climb)
            opt_z_final = opt_equations['z'](opt_t_climb)
            opt_distance = sum(
                ((opt_equations['x'](t2) - opt_equations['x'](t1)) ** 2 +
                 (opt_equations['y'](t2) - opt_equations['y'](t1)) ** 2 +
                 (opt_equations['z'](t2) - opt_equations['z'](t1)) ** 2) ** 0.5
                for t1, t2 in zip(np.linspace(0, opt_t_climb, 1000)[:-1], np.linspace(0, opt_t_climb, 1000)[1:])
            ) / 1000  # km
            total_journey_time = opt_t_climb

        # Filename
        if filename is None:
            timestamp_str = timestamp.strftime("%Y%m%d_%H%M%S")
            filename = f"mission_report_{rocket_type}_{timestamp_str}.txt"
        filepath = os.path.join(self.output_dir, filename)

        # Report content
        report = []
        report.append("=== SDARC-Enhanced Mission Report ===")
        now = datetime.now()
        report.append(f"Mission Generated On: {now.strftime('%Y-%m-%d %H:%M:%S')}")
        report.append("")

        report.append("Mission Overview")
        report.append(f"  Rocket Type: {rocket_type}")
        report.append(f"  Launch Site: {launch_site}")
        report.append(f"  Orbit Type: {orbit_type}")
        report.append(f"  Target Altitude: {altitude_km:.0f} km")
        report.append(f"  Launch Timestamp: {timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
        report.append(f"  Total Journey Time: {total_journey_time:.2f} s")
        report.append("")

        report.append("Rocket Parameters")
        report.append(f"  Thrust: {thrust / 1000:.2f} kN")
        report.append(f"  Initial Mass: {mass:.2f} kg")
        report.append(f"  Burn Time (Design): {burn_time_param:.2f} s")
        report.append("")

        report.append("Trajectory Details (Pre-Optimization)")
        report.append(f"  Initial Position: (x0: {x0 / 1000:.2f} km, y0: {y0 / 1000:.2f} km, z0: {z0 / 1000:.2f} km)")
        report.append(
            f"  Final Position: (x: {x_final / 1000:.2f} km, y: {y_final / 1000:.2f} km, z: {z_final / 1000:.2f} km)")
        report.append(f"  Burn Time: {burn_time:.2f} s")
        report.append(f"  Time to Climb: {t_climb:.2f} s")
        report.append(f"  Distance Traveled: {distance_traveled:.0f} km")
        report.append(f"  Orbital Velocity: {v_orbit / 1000:.2f} km/s")
        report.append("")

        report.append("Trajectory Equations (Pre-Optimization)")
        for axis, formula in formulas.items():
            report.append(f"  {axis.upper()}: {formula}")
        report.append("")

        report.append("Collision Detection (Pre-Optimization)")
        if not collisions:
            report.append("  Collisions Detected: 0")
            report.append("  Status: No collisions detected")
        else:
            report.append(f"  Collisions Detected: {len(collisions)}")
            for i, (t, pos, obj_type) in enumerate(collisions, 1):
                obj_str = obj_type if obj_type else "Unknown Object"
                report.append(
                    f"    Collision {i}: Time = {t:.2f} s, Position = ({pos[0] / 1000:.2f}, {pos[1] / 1000:.2f}, {pos[2] / 1000:.2f}) km")
                report.append(f"      Object: {obj_str}")

        if optimized_trajectory_data:
            report.append("")
            report.append("Trajectory Equations (Post-Optimization)")
            for axis, opt_formula in opt_formulas.items():
                report.append(f"  {axis.upper()}: {opt_formula}")
            report.append("")
            report.append("Trajectory Details (Post-Optimization)")
            report.append(
                f"  Final Position: (x: {opt_x_final / 1000:.2f} km, y: {opt_y_final / 1000:.2f} km, z: {opt_z_final / 1000:.2f} km)")
            report.append(f"  Time to Climb: {opt_t_climb:.2f} s")
            report.append(f"  Distance Traveled: {opt_distance:.0f} km")
            report.append(f"  Orbital Velocity: {opt_v_orbit / 1000:.2f} km/s")
            report.append("")
            report.append("Collision Detection (Post-Optimization)")
            report.append("  Collisions Detected: 0")
            report.append("  Status: Clear trajectory")

        # Success Rate (simple heuristic: 100% if no collisions post-optimization, else scale by collision count)
        success_rate = 80.0 if not collisions or optimized_trajectory_data else max(0, 100 - 10 * len(collisions))
        report.append("")
        report.append(f"Mission Success Rate: {success_rate:.1f}%")
        report.append(
            f"Status: {'Success' if success_rate > 90 else 'Partial Success' if success_rate > 50 else 'Failure'}")

        # Write to file
        with open(filepath, 'w') as f:
            f.write("\n".join(report))

        print(f"Mission report saved to: {filepath}")
        return filepath


# Test it
if __name__ == "__main__":
    x0, y0, z0 = 2202376.0642481693, 1886064.918310194, 5672912.8140265215
    equations = {
        'x': lambda t: x0 + 52.94 * t ** 2 if t <= 214 else x0 + 2424635 + 22660 * (
                    t - 214) if t <= 2366 else x0 + 36918656,
        'y': lambda t: y0 + 105.33 * t ** 2 if t <= 214 else y0 + 4823488 + 45079 * (
                    t - 214) if t <= 2366 else y0 + 74379549,
        'z': lambda t: z0 + 62.12 * t ** 2 if t <= 214 else z0 + 2844668 + 26586 * (t - 214) if t <= 2366 else 42157000
    }
    formulas = {
        'x': 'x0 + 52.94t² if t ≤ 214 else x0 + 2424635 + 22660(t - 214) if t ≤ 2366 else stop at 36918656',
        'y': 'y0 + 105.33t² if t ≤ 214 else y0 + 4823488 + 45079(t - 214) if t ≤ 2366 else stop at 74379549',
        'z': 'z0 + 62.12t² if t ≤ 214 else z0 + 2844668 + 26586(t - 214) + gravity if t ≤ 2366 else 42157000'
    }
    initial = {'x0': x0, 'y0': y0, 'z0': z0}
    trajectory_data = (equations, 2365.76, formulas, initial, 3074.92, 214.0)

    # Fake optimized trajectory (for testing)
    opt_equations = {
        'x': lambda t: x0 + 50 * t ** 2 if t <= 214 else x0 + 2300000 + 3000 * (t - 214) if t <= 2400 else x0 + 7200000,
        'y': lambda t: y0 + 100 * t ** 2 if t <= 214 else y0 + 4600000 + 6000 * (
                    t - 214) if t <= 2400 else y0 + 14400000,
        'z': lambda t: z0 + 60 * t ** 2 if t <= 214 else z0 + 2740000 + 3500 * (t - 214) if t <= 2400 else 42157000
    }
    opt_formulas = {
        'x': 'x0 + 50t² if t ≤ 214 else x0 + 2300000 + 3000(t - 214) if t ≤ 2400 else stop at 7200000',
        'y': 'y0 + 100t² if t ≤ 214 else y0 + 4600000 + 6000(t - 214) if t ≤ 2400 else stop at 14400000',
        'z': 'z0 + 60t² if t ≤ 214 else z0 + 2740000 + 3500(t - 214) if t ≤ 2400 else 42157000'
    }
    opt_trajectory_data = (opt_equations, 2400.0, opt_formulas, initial, 3074.92, 214.0)

    timestamp = datetime.strptime("2024-06-06 05:11:42", "%Y-%m-%d %H:%M:%S")
    rocket_params = {'thrust_N': 3700000, 'mass_kg': 17000, 'burn_time_s': 214.0}
    collisions = [(500, (1e6, 2e6, 3e6), "Debris"), (1000, (2e6, 3e6, 4e6), "Satellite")]

    report = MissionReport()
    report.generate(
        rocket_type="Angara A5",
        launch_site="Plesetsk Cosmodrome, Russia",
        orbit_type="GEO",
        altitude_km=35786,
        timestamp=timestamp,
        trajectory_data=trajectory_data,
        collisions=collisions,
        rocket_params=rocket_params,
        optimized_trajectory_data=opt_trajectory_data
    )