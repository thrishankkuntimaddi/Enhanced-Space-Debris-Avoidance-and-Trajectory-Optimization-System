import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D


class TrajectoryVisualizer:
    def __init__(self, equations, t_max, num_points=500):
        """
        Initialize with trajectory equations and time range.
        Args:
            equations (dict): {'x': str, 'y': str, 'z': str} from TrajectoryCalculator
            t_max (float): Max time (e.g., time to altitude)
            num_points (int): Number of points to plot
        """
        self.equations = equations
        self.t_values = np.linspace(0, t_max, num_points)
        self.x_func = self._parse_equation(equations['x'])
        self.y_func = self._parse_equation(equations['y'])
        # Handle z separately due to conditional
        self.z_func = self._parse_z_equation(equations['z'], t_max)

    def _parse_equation(self, eq_str):
        """Convert simple string equation to a callable function."""
        # Replace ** with np.power
        eq_str = eq_str.replace('**', 'np.power')

        def func(t):
            return eval(eq_str, {'t': t, 'np': np})

        return func

    def _parse_z_equation(self, eq_str, t_max):
        """Handle z equation with conditional logic."""
        # Extract burn_time from equation (e.g., 't <= 80')
        burn_time = float(eq_str.split('<=')[1].split()[0])
        accel_part = eq_str.split('if')[0].strip()  # e.g., "0 + 2074.13 * t**2"
        coast_part = eq_str.split('else')[1].strip()  # e.g., "13279360.0"

        def func(t):
            if t <= burn_time:
                return eval(accel_part, {'t': t, 'np': np})
            else:
                # Cap at max altitude if beyond burn time
                return min(eval(accel_part, {'t': burn_time, 'np': np}), t_max * 1000)  # t_max in km to m

        return func

    def plot(self, title="Initial Rocket Trajectory"):
        """Generate and display a 3D plot of the trajectory."""
        x = np.array([self.x_func(t) for t in self.t_values])
        y = np.array([self.y_func(t) for t in self.t_values])
        z = np.array([self.z_func(t) for t in self.t_values])

        fig = plt.figure(figsize=(10, 7))
        ax = fig.add_subplot(111, projection='3d')
        ax.plot(x, y, z / 1000, label='Trajectory', color='b')  # Convert z from m to km

        ax.set_xlabel('X (km)')
        ax.set_ylabel('Y (km)')
        ax.set_zlabel('Z (km)')
        ax.set_title(title)
        ax.legend()

        # Adjust axes limits
        ax.set_xlim(min(x.min(), 0), max(x.max(), 0))
        ax.set_ylim(min(y.min(), 0), max(y.max(), 0))
        ax.set_zlim(0, max(z.max() / 1000, 100))  # z in km

        plt.show()

#
# if __name__ == "__main__":
#     # Example from Electron at 500 km
#     test_equations = {
#         'x': '-39.261 + 5649.37 * t',
#         'y': '177.864 + 5258.77 * t',
#         'z': '0 + 2074.13 * t**2 if t <= 80 else 13279360.0'
#     }
#     viz = TrajectoryVisualizer(test_equations, t_max=15.54)
#     viz.plot()