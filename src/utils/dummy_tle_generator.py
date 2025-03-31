import random
import os
from datetime import datetime, timedelta
import numpy as np


def generate_dummy_tle(debris_count, output_path, timestamp, target_altitude, lat, lon, equations, t_climb):
    """
    Generate TLEs that collide with the trajectory at specific points and times.
    """
    line1_template = "1 {satnum:05d}U 25A   {epoch} {mean_motion_dot:12.8f} {mean_motion_ddot:12.8f} {bstar:8.6e} 0 {elem_num:4d}"
    line2_template = "2 {satnum:05d} {inc:8.4f} {raan:8.4f} {ecc:7.7f} {argp:8.4f} {ma:8.4f} {n:11.8f} {rev_num:5d}"

    R = 6371e3  # Earth radius (m)
    GM = 3.986e14  # Gravitational parameter (m^3/s^2)

    tles = []
    for i in range(debris_count):
        satnum = 70000 + i
        # Pick a collision time
        t_collision = random.uniform(t_climb * 0.2, t_climb * 0.8)

        # Position at collision time
        x = equations['x'](t_collision)
        y = equations['y'](t_collision)
        z = equations['z'](t_collision)
        r = np.sqrt(x ** 2 + y ** 2 + z ** 2)

        # Velocity approximation (numerical derivative)
        dt = 0.1  # Small time step
        vx = (equations['x'](t_collision + dt) - equations['x'](t_collision)) / dt
        vy = (equations['y'](t_collision + dt) - equations['y'](t_collision)) / dt
        vz = (equations['z'](t_collision + dt) - equations['z'](t_collision)) / dt
        v = np.sqrt(vx ** 2 + vy ** 2 + vz ** 2)

        # Orbital elements
        a = r  # Semi-major axis (circular orbit for simplicity)
        n = np.sqrt(GM / a ** 3) * 86400 / (2 * np.pi)  # Mean motion (revs/day)
        inc = np.degrees(np.arccos(z / r))
        inc = min(max(inc, 0.1), 179.9)  # Avoid singularities
        raan = np.degrees(np.arctan2(y, x)) % 360

        # Assume circular orbit for simplicity
        ecc = 0.0001  # Tiny eccentricity
        argp = 0.0  # Irrelevant for circular orbit

        # Mean anomaly to place debris at position at t_collision
        # Debris should be at (x, y, z) when rocket arrives
        ma = 0.0  # Start at perigee; epoch will align it

        # Epoch is timestamp + t_collision
        collision_time = timestamp + timedelta(seconds=t_collision)
        year = str(collision_time.year)[-2:]
        day_of_year = collision_time.timetuple().tm_yday
        fraction = (collision_time.hour * 3600 + collision_time.minute * 60 + collision_time.second) / 86400
        epoch = f"{year}{day_of_year:03d}.{fraction:08f}"

        # TLE params
        bstar = random.uniform(0.0001, 0.001)
        mean_motion_dot = random.uniform(-0.00001, 0.00001)
        mean_motion_ddot = random.uniform(-0.000001, 0.000001)
        elem_num = random.randint(1, 9999)
        rev_num = random.randint(1, 9999)

        line1 = line1_template.format(
            satnum=satnum, epoch=epoch, mean_motion_dot=mean_motion_dot,
            mean_motion_ddot=mean_motion_ddot, bstar=bstar, elem_num=elem_num
        )
        line2 = line2_template.format(
            satnum=satnum, inc=inc, raan=raan, ecc=ecc, argp=argp, ma=ma, n=n, rev_num=rev_num
        )
        tles.append(line1)
        tles.append(line2)

    with open(output_path, 'w') as f:
        f.write("\n".join(tles))

    return f"Generated {debris_count} dummy TLEs positioned on trajectory"