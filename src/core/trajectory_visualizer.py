# src/core/trajectory_visualizer.py
import numpy as np
import plotly.graph_objects as go
import webbrowser  # For sound trigger

class TrajectoryVisualizer:
    def __init__(self, equations, t_max, num_points=500, burn_time=None):
        self.equations = equations
        self.t_max = t_max
        self.t_values = np.linspace(0, t_max, num_points)
        self.burn_time = burn_time if burn_time is not None else t_max
        self.R = 6371e3  # Earth radius (m)
        self.GM = 3.986e14  # Gravitational parameter (m^3/s^2)

    def plot(self, title="Rocket Trajectory with Orbital Ring"):
        x = [self.equations['x'](t) for t in self.t_values]
        y = [self.equations['y'](t) for t in self.t_values]
        z = [self.equations['z'](t) for t in self.t_values]

        x_km = np.array(x) / 1000
        y_km = np.array(y) / 1000
        z_km = np.array(z) / 1000

        # Debug
        print(f"x_km[:5]: {x_km[:5]}")
        print(f"y_km[:5]: {y_km[:5]}")
        print(f"z_km[:5]: {z_km[:5]}")
        print(f"x_km[-5:]: {x_km[-5:]}")
        print(f"y_km[-5:]: {y_km[-5:]}")
        print(f"z_km[-5:]: {z_km[-5:]}")

        # Split burn and coast
        burn_idx = np.searchsorted(self.t_values, self.burn_time, side='right')
        x_burn, x_coast = x_km[:burn_idx], x_km[burn_idx:]
        y_burn, y_coast = y_km[:burn_idx], y_km[burn_idx:]
        z_burn, z_coast = z_km[:burn_idx], z_km[burn_idx:]
        t_burn, t_coast = self.t_values[:burn_idx], self.t_values[burn_idx:]

        fig = go.Figure()

        # Burn phase with flare
        fig.add_trace(go.Scatter3d(
            x=x_burn, y=y_burn, z=z_burn,
            mode='lines',
            name='Burn Phase',
            line=dict(color='orange', width=8),
            hovertemplate='X: %{x:.2f} km<br>Y: %{y:.2f} km<br>Z: %{z:.2f} km<br>Time: %{customdata:.2f} s',
            customdata=t_burn
        ))

        # Coast phase with gradient
        fig.add_trace(go.Scatter3d(
            x=x_coast, y=y_coast, z=z_coast,
            mode='lines',
            name='Coast Phase',
            line=dict(color=t_coast, colorscale='Viridis', width=6, showscale=True, colorbar=dict(title="Time (s)")),
            hovertemplate='X: %{x:.2f} km<br>Y: %{y:.2f} km<br>Z: %{z:.2f} km<br>Time: %{customdata:.2f} s',
            customdata=t_coast
        ))

        # Start and End Markers
        fig.add_trace(go.Scatter3d(
            x=[x_km[0]], y=[y_km[0]], z=[z_km[0]],
            mode='markers+text',
            name='Launch',
            marker=dict(size=12, color='green', symbol='circle'),
            text=['Start'],
            textposition='top center'
        ))
        fig.add_trace(go.Scatter3d(
            x=[x_km[-1]], y=[y_km[-1]], z=[z_km[-1]],
            mode='markers+text',
            name='Target',
            marker=dict(size=12, color='red', symbol='circle'),
            text=['End'],
            textposition='top center'
        ))

        # Earth sphere
        u = np.linspace(0, 2 * np.pi, 50)
        v = np.linspace(0, np.pi, 50)
        earth_radius_km = 6371
        x_earth = earth_radius_km * np.outer(np.cos(u), np.sin(v))
        y_earth = earth_radius_km * np.outer(np.sin(u), np.sin(v))
        z_earth = earth_radius_km * np.outer(np.ones(np.size(u)), np.cos(v))
        fig.add_trace(go.Surface(
            x=x_earth, y=y_earth, z=z_earth,
            colorscale='Blues',
            opacity=0.7,
            showscale=False,
            name='Earth'
        ))

        # Orbital ring at target altitude (20,000 km)
        r_target_km = (self.R + 20000e3) / 1000  # 20,000 km altitude
        theta = np.linspace(0, 2 * np.pi, 100)
        x_ring = r_target_km * np.cos(theta)
        y_ring = r_target_km * np.sin(theta)
        z_ring = np.zeros_like(theta) + z_km[-1]  # Match end altitude
        fig.add_trace(go.Scatter3d(
            x=x_ring, y=y_ring, z=z_ring,
            mode='lines',
            name='Orbital Ring',
            line=dict(color='cyan', width=4, dash='dash'),
            hoverinfo='skip'
        ))

        # Velocity vector at burn end
        vx = (x_km[burn_idx] - x_km[burn_idx-1]) / (self.t_values[burn_idx] - self.t_values[burn_idx-1])
        vy = (y_km[burn_idx] - y_km[burn_idx-1]) / (self.t_values[burn_idx] - self.t_values[burn_idx-1])
        vz = (z_km[burn_idx] - z_km[burn_idx-1]) / (self.t_values[burn_idx] - self.t_values[burn_idx-1])
        fig.add_trace(go.Cone(
            x=[x_km[burn_idx]], y=[y_km[burn_idx]], z=[z_km[burn_idx]],
            u=[vx], v=[vy], w=[vz],
            sizemode='scaled', sizeref=100,
            colorscale='Reds',
            showscale=False,
            name='Velocity at Burn End'
        ))

        # Dashboard stats
        max_altitude = z_km.max()
        distance_traveled = np.sum(np.sqrt(np.diff(x_km)**2 + np.diff(y_km)**2 + np.diff(z_km)**2))
        v_orbit = np.sqrt(self.GM / (self.R + 20000e3)) / 1000  # km/s
        annotations = [
            dict(text=f"Max Altitude: {max_altitude:.2f} km", x=0.05, y=0.95, xref="paper", yref="paper", showarrow=False),
            dict(text=f"Distance Traveled: {distance_traveled:.2f} km", x=0.05, y=0.90, xref="paper", yref="paper", showarrow=False),
            dict(text=f"Burn Time: {self.burn_time:.2f} s", x=0.05, y=0.85, xref="paper", yref="paper", showarrow=False),
            dict(text=f"Orbital Velocity: {v_orbit:.2f} km/s", x=0.05, y=0.80, xref="paper", yref="paper", showarrow=False)
        ]

        # Layout
        fig.update_layout(
            title=dict(text=title, font_size=20, x=0.5, xanchor='center'),
            scene=dict(
                xaxis_title='X (km)',
                yaxis_title='Y (km)',
                zaxis_title='Z (km)',
                xaxis=dict(range=[-30000, 30000], showgrid=True, zeroline=True),
                yaxis=dict(range=[-30000, 30000], showgrid=True, zeroline=True),
                zaxis=dict(range=[0, 30000], showgrid=True, zeroline=True),
                aspectmode='manual',
                aspectratio=dict(x=1, y=1, z=1),
                camera=dict(eye=dict(x=1.8, y=1.8, z=1.2))
            ),
            annotations=annotations,
            showlegend=True,
            template="plotly_dark",
            margin=dict(l=0, r=0, t=50, b=0),
            updatemenus=[dict(
                type="buttons",
                buttons=[dict(label="Play",
                              method="animate",
                              args=[None, {"frame": {"duration": 30, "redraw": True}, "fromcurrent": True, "mode": "immediate"}]),
                         dict(label="Pause",
                              method="animate",
                              args=[[None], {"frame": {"duration": 0, "redraw": False}, "mode": "immediate"}])],
                direction="left",
                pad={"r": 10, "t": 10},
                showactive=True,
                x=0.1,
                xanchor="left",
                y=1.1,
                yanchor="top"
            )],
        )

        # Animation frames
        frames = [go.Frame(data=[go.Scatter3d(
            x=x_km[:k+1], y=y_km[:k+1], z=z_km[:k+1],
            mode='lines',
            line=dict(color='orange' if k < burn_idx else 'purple', width=8)
        )]) for k in range(len(x_km))]
        fig.frames = frames

        # Sound trigger (basic beep via browser)
        sound_script = """
        <script>
        function playSound() {
            var audio = new Audio('/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/sounds/Rocket_launch.mp3');
            audio.play();
        }
        playSound();
        </script>
        """
        fig.add_annotation(
            text=sound_script,
            showarrow=False,
            xref="paper", yref="paper",
            x=0, y=0
        )

        fig.show()

# Test with your equations
if __name__ == "__main__":
    x0, y0, z0 = 924092.27, -5522157.68, 3039978.46
    equations = {
        'x': lambda t: x0 + 5515.43 * t * np.cos(-1.40) if t <= 80 else x0 + 72824.72,
        'y': lambda t: y0 + 5515.43 * t * np.sin(-1.40) if t <= 80 else y0 + -435183.36,
        'z': lambda t: z0 + 5515.43 * t if t <= 80 else z0 + 441234.63
    }
    vz = 5515.43
    target_altitude = 20000e3
    t_climb = (target_altitude - z0) / vz  # ~3086 s
    viz = TrajectoryVisualizer(equations, t_max=t_climb, burn_time=80.0)
    viz.plot()