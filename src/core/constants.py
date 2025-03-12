import numpy as np

# Earth
R = 6371e3  # Earth radius (m)
GM = 3.986e14  # Gravitational parameter (m^3/s^2)

# Rocket (e.g., Electron-inspired)
m0 = 13100  # Initial mass (kg)
thrust = 192e3  # Thrust (N)
isp = 311  # Specific impulse (s)
g0 = 9.81  # Sea-level gravity (m/s^2)
mdot = thrust / (isp * g0)  # Mass flow rate (kg/s) ≈ 62.9 kg/s
burn_time = 80.0  # Burn duration (s)
m_fuel = mdot * burn_time  # Fuel mass burned ≈ 5032 kg
m_dry = m0 - m_fuel  # Dry mass ≈ 8068 kg

# Initial conditions
lat0, lon0, z0 = 28.5, -80.5, 0  # Launch site (Cape Canaveral)
theta0 = np.radians(lat0)
phi0 = np.radians(lon0)
x0 = R * np.cos(theta0) * np.cos(phi0)  # ≈ 924092 m
y0 = R * np.cos(theta0) * np.sin(phi0)  # ≈ -5522158 m
z0 = R * np.sin(theta0)  # ≈ 3039978 m
target_altitude = 20000e3  # 20,000 km
r_target = R + target_altitude  # 26,371 km from center
v_orbit = np.sqrt(GM / r_target)  # ≈ 4466 m/s