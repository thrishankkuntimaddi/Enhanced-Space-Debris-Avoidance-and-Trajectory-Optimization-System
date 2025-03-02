from src.core.timestamp_selector import TimestampSelector
from src.core.orbit_selector import OrbitSelector
from src.core.rocket_selector import RocketSelector
from src.core.trajectory_calculator import TrajectoryCalculator
from src.core.trajectory_visualizer import TrajectoryVisualizer

def main():
    timestamp = TimestampSelector().run()
    print(f"Final selected timestamp: {timestamp}")
    altitude, orbit_type = OrbitSelector().run()
    print(f"Final selection: {orbit_type} at {altitude} km")
    rocket_info = RocketSelector().run(altitude, orbit_type)
    print(f"Launch: {timestamp}, {orbit_type} at {altitude} km with {rocket_info['rocket_type']}")

    traj_calc = TrajectoryCalculator()
    equations, t_climb = traj_calc.calculate(rocket_info['rocket_type'], altitude, rocket_info['coordinates'])
    print(f"Trajectory: {equations}, Time to altitude: {t_climb:.2f} s")

    viz = TrajectoryVisualizer(equations, t_climb)
    viz.plot()

if __name__ == "__main__":
    main()

