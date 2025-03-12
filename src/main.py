# src/main.py
import os
from datetime import datetime
from src.utils.tle_preprocessor import preprocess_and_save_tle
from src.core.timestamp_selector import TimestampSelector
from src.core.orbit_selector import OrbitSelector
from src.core.rocket_selector import RocketSelector
from src.core.trajectory_calculator import TrajectoryCalculator
from src.core.collision_detector import CollisionDetector
from src.core.ddql_optimizer import DDQLOptimizer
from src.core.trajectory_visualizer import TrajectoryVisualizer
from src.core.mission_report import MissionReport

def main():
    base_dir = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced"
    input_tle_path = os.path.join(base_dir, "inputs", "tle_raw.txt")
    output_tle_path = os.path.join(base_dir, "data", "tle_data.txt")

    print("Preprocessing TLE data...")
    try:
        preprocess_and_save_tle(input_tle_path, output_tle_path)
    except Exception as e:
        print(f"Error preprocessing TLE data: {e}")
        return

    print("\n")

    print("Selecting launch timestamp...")
    try:
        timestamp = TimestampSelector(tle_data_path=input_tle_path).run()
        print(f"Selected timestamp: {timestamp}")
    except Exception as e:
        print(f"Error selecting timestamp: {e}")
        return

    print("\n")

    print("Selecting orbit...")
    try:
        altitude, orbit_type = OrbitSelector().run()
        print(f"Selected: {orbit_type} at {altitude} km")
    except Exception as e:
        print(f"Error selecting orbit: {e}")
        return

    print("\n")

    print("Selecting rocket...")
    selector = RocketSelector()
    try:
        rocket_info = selector.run(altitude, orbit_type)
        print(f"Selected: {rocket_info['rocket_type']} from {rocket_info['launch_site']} at {rocket_info['coordinates']}")
    except Exception as e:
        print(f"Error selecting rocket: {e}")
        print(f"RocketSelector state: {vars(selector)}")
        return

    print("\n")

    print("Calculating initial trajectory...")
    traj_calc = TrajectoryCalculator()
    try:
        equations, t_climb, formulas, initial, orbit_vel, burn_time = traj_calc.calculate(
            rocket_info['rocket_type'], altitude, rocket_info['coordinates']
        )
        trajectory_data = (equations, t_climb, formulas, initial, orbit_vel, burn_time)
        print(f"Initial: {initial}")
        print(f"Formulas: {formulas}")
        print(f"t_climb: {t_climb:.2f}s")
        print(f"burn_time: {burn_time:.2f}s")
        print(f"Orbital Velocity: {orbit_vel:.2f} m/s")
    except Exception as e:
        print(f"Error calculating trajectory: {e}")
        return

    print("\n")

    print("Running collision detection...")
    try:
        detector = CollisionDetector(tle_txt_path=output_tle_path, threshold_km=1.0)
        collisions = detector.detect_collisions(equations, timestamp, t_climb)
        # Enhance collisions with object type (assuming detector returns (t, pos, obj_type) or just (t, pos))
        collisions_with_obj = [(t, pos, "Unknown Object") for t, pos in collisions] if collisions else []
        print(f"Collisions detected: {len(collisions)}")
        for t, pos in collisions:
            print(f" - Collision at t={t:.2f}s, debris position={pos}")
    except Exception as e:
        print(f"Error during collision detection: {e}")
        return

    print("\n")

    optimized_trajectory_data = None
    if collisions:
        print("Optimizing trajectory...")
        try:
            optimizer = DDQLOptimizer(equations, t_climb, timestamp, output_tle_path, threshold_km=1.0)
            optimized_equations = optimizer.optimize(collisions)
            print(f"Optimized trajectory equations generated.")
            # Recalculate optimized trajectory data
            opt_equations, opt_t_climb, opt_formulas, opt_initial, opt_orbit_vel, opt_burn_time = traj_calc.calculate(
                rocket_info['rocket_type'], altitude, rocket_info['coordinates']
            )  # Simplified—use optimized_equations if calc supports it
            optimized_trajectory_data = (optimized_equations, opt_t_climb, opt_formulas, opt_initial, opt_orbit_vel, opt_burn_time)
            collisions = detector.detect_collisions(optimized_equations, timestamp, opt_t_climb)
            collisions_with_obj = [(t, pos, "Unknown Object") for t, pos in collisions] if collisions else []
            print(f"Post-optimization collisions: {len(collisions)}")
            equations = optimized_equations  # Use optimized for viz
        except Exception as e:
            print(f"Error during optimization: {e}")
            return
    else:
        print("No optimization needed.")

    print("\n")

    print("Visualizing trajectory...")
    try:
        viz = TrajectoryVisualizer(equations, t_max=t_climb, burn_time=burn_time)
        viz.plot(title=f"Trajectory to {altitude} km", collisions=collisions_with_obj)
    except Exception as e:
        print(f"Error visualizing trajectory: {e}")
        return

    print("\n")

    print("Generating mission report...")
    try:
        # Rocket params from TrajectoryCalculator's rocket_data
        rocket_data = traj_calc.rocket_data
        rocket_params = {
            'thrust_N': float(rocket_data[rocket_data['Rocket_Type'] == rocket_info['rocket_type']]['Thrust_N'].iloc[0]),
            'mass_kg': float(rocket_data[rocket_data['Rocket_Type'] == rocket_info['rocket_type']]['Mass_kg'].iloc[0]),
            'burn_time_s': float(rocket_data[rocket_data['Rocket_Type'] == rocket_info['rocket_type']]['Burn_Time_s'].iloc[0])
        }
        report = MissionReport()
        report.generate(
            rocket_type=rocket_info['rocket_type'],
            launch_site=rocket_info['launch_site'],
            orbit_type=orbit_type,
            altitude_km=altitude,
            timestamp=timestamp,
            trajectory_data=trajectory_data,
            collisions=collisions_with_obj,
            rocket_params=rocket_params,
            optimized_trajectory_data=optimized_trajectory_data
        )
    except Exception as e:
        print(f"Error generating mission report: {e}")
        return

    print("\n")

    print("Space Debris Avoidance and Trajectory Optimization System - simulation complete!")

if __name__ == "__main__":
    main()