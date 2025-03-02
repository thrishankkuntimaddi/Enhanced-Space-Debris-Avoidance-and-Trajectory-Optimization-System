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

    print("Selecting launch timestamp...")
    try:
        timestamp = TimestampSelector(tle_data_path=output_tle_path).run()
        print(f"Selected timestamp: {timestamp}")
    except Exception as e:
        print(f"Error selecting timestamp: {e}")
        return

    print("Selecting orbit...")
    try:
        altitude, orbit_type = OrbitSelector().run()
        print(f"Selected: {orbit_type} at {altitude} km")
    except Exception as e:
        print(f"Error selecting orbit: {e}")
        return

    print("Selecting rocket...")
    selector = RocketSelector()  # Instantiate outside try block
    try:
        rocket_info = selector.run(altitude, orbit_type)
        print(f"Selected: {rocket_info['rocket_type']} from {rocket_info['launch_site']} at {rocket_info['coordinates']}")
    except Exception as e:
        print(f"Error selecting rocket: {e}")
        print(f"RocketSelector state: {vars(selector)}")  # Debug info still works
        return

    print("Calculating initial trajectory...")
    traj_calc = TrajectoryCalculator()
    equations, t_climb, formulas, initial, orbit_vel = traj_calc.calculate(rocket_info['rocket_type'], altitude, rocket_info['coordinates'])
    print(f"Initial: {initial}")
    print(f"Formulas: {formulas}")
    print(f"t_climb: {t_climb:.2f}s")
    print(f"Equations: {equations}")
    print(f"Orbital Velocity: {orbit_vel}")

    print("Running collision detection...")
    try:
        detector = CollisionDetector(tle_txt_path=output_tle_path, threshold_km=1.0)
        collisions = detector.detect_collisions(equations, timestamp, t_climb)
        print(f"Collisions detected: {len(collisions)}")
        for t, pos in collisions:
            print(f" - Collision at t={t:.2f}s, debris position={pos}")
    except Exception as e:
        print(f"Error during collision detection: {e}")
        return

    if collisions:
        print("Optimizing trajectory...")
        try:
            optimizer = DDQLOptimizer(equations, t_climb, timestamp, output_tle_path, threshold_km=1.0)
            optimized_equations = optimizer.optimize(collisions)
            print(f"Optimized trajectory: {optimized_equations}")
            collisions = detector.detect_collisions(optimized_equations, timestamp, t_climb)
            print(f"Post-optimization collisions: {len(collisions)}")
            equations = optimized_equations
        except Exception as e:
            print(f"Error during optimization: {e}")
            return
    else:
        print("No optimization needed.")

    print("Visualizing trajectory...")
    try:
        viz = TrajectoryVisualizer(equations, int(t_climb), burn_time=80.0)
        viz.plot()
    except Exception as e:
        print(f"Error visualizing trajectory: {e}")
        return

    print("SDARC-Enhanced simulation complete!")

if __name__ == "__main__":
    main()