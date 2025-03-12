# src/core/trajectory_visualizer.py
import numpy as np
import plotly.graph_objects as go

class TrajectoryVisualizer:
    def __init__(self, equations, t_max, burn_time, num_points=2000):  # More points for smoothness
        self.equations = equations
        self.t_max = t_max
        self.burn_time = burn_time
        self.num_points = num_points
        self.R = 6371e3
        self.GM = 3.986e14

    def plot(self, title="Rocket Trajectory", collisions=None):
        t_values = np.linspace(0, self.t_max, self.num_points)
        x = np.array([self.equations['x'](t) for t in t_values])
        y = np.array([self.equations['y'](t) for t in t_values])
        z = np.array([self.equations['z'](t) for t in t_values])
        x_km = x / 1000
        y_km = y / 1000
        z_km = z / 1000

        # Cap at climb
        target_z_km = z_km[-1]
        climb_idx = np.argmax(z_km >= target_z_km) if np.any(z_km >= target_z_km) else -1
        if climb_idx == -1:
            climb_idx = len(z_km) - 1

        t_climb_values = t_values[:climb_idx + 1]
        x_climb_km = x_km[:climb_idx + 1]
        y_climb_km = y_km[:climb_idx + 1]
        z_climb_km = z_km[:climb_idx + 1]

        # Split burn and coast
        burn_idx = np.searchsorted(t_climb_values, self.burn_time, side='right')
        x_burn, x_coast = x_climb_km[:burn_idx], x_climb_km[burn_idx:]
        y_burn, y_coast = y_climb_km[:burn_idx], y_climb_km[burn_idx:]
        z_burn, z_coast = z_climb_km[:burn_idx], z_climb_km[burn_idx:]

        fig = go.Figure()

        # Earth
        u, v = np.linspace(0, 2 * np.pi, 50), np.linspace(0, np.pi, 50)
        x_earth = 6371 * np.outer(np.cos(u), np.sin(v))
        y_earth = 6371 * np.outer(np.sin(u), np.sin(v))
        z_earth = 6371 * np.outer(np.ones(np.size(u)), np.cos(v))
        fig.add_trace(go.Surface(x=x_earth, y=y_earth, z=z_earth, colorscale='Blues', opacity=0.8, showscale=False))

        # Trajectory
        fig.add_trace(go.Scatter3d(x=x_burn, y=y_burn, z=z_burn, mode='lines', name='Burn', line=dict(color='orange', width=8)))
        fig.add_trace(go.Scatter3d(x=x_coast, y=y_coast, z=z_coast, mode='lines', name='Coast', line=dict(color='green', width=6)))

        # Start/End
        fig.add_trace(go.Scatter3d(x=[x_climb_km[0]], y=[y_climb_km[0]], z=[z_climb_km[0]], mode='markers+text', name='Launch', marker=dict(size=15, color='lime'), text=['START'], textposition='top center'))
        fig.add_trace(go.Scatter3d(x=[x_climb_km[-1]], y=[y_climb_km[-1]], z=[z_climb_km[-1]], mode='markers+text', name='Target', marker=dict(size=15, color='red'), text=['TARGET'], textposition='top center'))

        # Target ring
        r_target_km = z_climb_km[-1]
        theta = np.linspace(0, 2 * np.pi, 100)
        x_ring = r_target_km * np.cos(theta)
        y_ring = r_target_km * np.sin(theta)
        z_ring = np.full_like(theta, r_target_km)
        fig.add_trace(go.Scatter3d(x=x_ring, y=y_ring, z=z_ring, mode='lines', name='Target Altitude', line=dict(color='cyan', width=6, dash='dash')))

        # Collisions
        if collisions:
            t_coll, pos_coll = zip(*collisions)
            x_coll = [p[0] / 1000 for p in pos_coll]
            y_coll = [p[1] / 1000 for p in pos_coll]
            z_coll = [p[2] / 1000 for p in pos_coll]
            fig.add_trace(go.Scatter3d(x=x_coll, y=y_coll, z=z_coll, mode='markers', name='Collisions', marker=dict(size=10, color='red', symbol='x')))

        # Stats
        max_altitude = z_climb_km.max() - 6371
        distance = np.sum(np.sqrt(np.diff(x_climb_km)**2 + np.diff(y_climb_km)**2 + np.diff(z_climb_km)**2))
        annotations = [
            dict(text=f"Target Altitude: {max_altitude:.0f} km", x=0.95, y=0.95, xref="paper", yref="paper", showarrow=False),
            dict(text=f"Distance Traveled: {distance:.0f} km", x=0.95, y=0.90, xref="paper", yref="paper", showarrow=False),
            dict(text=f"Burn Time: {self.burn_time:.0f} s", x=0.95, y=0.85, xref="paper", yref="paper", showarrow=False)
        ]

        frame_duration = max(20, int(self.t_max * 1000 / len(t_values)))
        fig.update_layout(
            title=dict(text=title, font_size=20, x=0.5, xanchor='center'),
            scene=dict(
                xaxis_title='X (km)', yaxis_title='Y (km)', zaxis_title='Z (km)',
                xaxis=dict(showgrid=True), yaxis=dict(showgrid=True), zaxis=dict(showgrid=True),
                aspectmode='data', camera=dict(eye=dict(x=2, y=2, z=1.5))
            ),
            annotations=annotations,
            showlegend=True,
            template="plotly_dark",
            updatemenus=[dict(
                buttons=[
                    dict(label="Play", method="animate", args=[None, {"frame": {"duration": frame_duration, "redraw": True}, "fromcurrent": True}]),
                    dict(label="Pause", method="animate", args=[[None], {"frame": {"duration": 0, "redraw": False}, "mode": "immediate"}])
                ],
                direction="left", pad={"r": 10, "t": 10}, x=0.1, y=1.1, yanchor="top"
            )]
        )

        frames = [go.Frame(data=[
            go.Scatter3d(x=x_climb_km[:k + 1], y=y_climb_km[:k + 1], z=z_climb_km[:k + 1], mode='lines',
                         line=dict(color='orange' if k < burn_idx else 'green', width=8))]) for k in range(len(x_climb_km))]
        fig.frames = frames

        fig.show()
        return fig  # For Flask, no show()

# Test tweak
if __name__ == "__main__":
    x0, y0, z0 = 2202376.0642481693, 1886064.918310194, 5672912.8140265215
    equations = {
        'x': lambda t: x0 + 52.94 * t**2 if t <= 214 else x0 + 2424635 + 22660 * (t - 214) if t <= 2366 else x0 + 36918656,
        'y': lambda t: y0 + 105.33 * t**2 if t <= 214 else y0 + 4823488 + 45079 * (t - 214) if t <= 2366 else y0 + 74379549,
        'z': lambda t: z0 + 62.12 * t**2 if t <= 214 else z0 + 2844668 + 26586 * (t - 214) if t <= 2366 else 42157000
    }
    t_climb = 2365.76
    burn_time = 214.0
    viz = TrajectoryVisualizer(equations, t_max=t_climb, burn_time=burn_time, num_points=2000)  # More points
    viz.plot()
    # Force slower animation for testing
    # Change frame_duration = 20 in the codet()