from flask import Flask, render_template, request, jsonify, redirect
from werkzeug.utils import secure_filename
import os
from datetime import datetime, timedelta
from src.utils.tle_preprocessor import preprocess_and_save_tle
from src.core.timestamp_selector import TimestampSelector
from src.core.orbit_selector import OrbitSelector
from src.core.rocket_selector import RocketSelector
from src.core.trajectory_calculator import TrajectoryCalculator
from src.core.collision_detector import CollisionDetector
from src.core.ddql_optimizer import DDQLOptimizer
from src.core.trajectory_visualizer import TrajectoryVisualizer
from src.core.mission_report import MissionReport
from flask_cors import CORS

app = Flask(__name__, template_folder='templates', static_folder='static')
CORS(app)

BASE_DIR = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced"
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
OUTPUT_TLE = os.path.join(BASE_DIR, "data", "tle_data.txt")
REPORTS_DIR = os.path.join(BASE_DIR, "outputs", "mission_reports")
STATIC_DIR = os.path.join(BASE_DIR, "src", "interface", "static")
ALLOWED_EXTENSIONS = {'txt'}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/input_page')
def input_page():
    return render_template('input_page.html')

@app.route('/upload', methods=['POST'])
def upload_dataset():
    file = request.files.get('file')
    if file and allowed_file(file.filename):
        filepath = os.path.join(UPLOAD_FOLDER, secure_filename(file.filename))
        file.save(filepath)
        preprocess_and_save_tle(filepath, OUTPUT_TLE)
        return jsonify({'message': 'TLE processed successfully'}), 200
    return jsonify({'error': 'Invalid file'}), 400

@app.route('/get_timestamps', methods=['GET'])
def get_timestamps():
    selector = TimestampSelector(tle_data_path=OUTPUT_TLE)
    min_time = selector._get_tle_epoch_start()  # Earliest TLE epoch
    max_time = min_time + timedelta(days=7)     # 7-day window
    return jsonify({
        'min': min_time.strftime("%Y/%m/%d %H:%M:%S"),
        'max': max_time.strftime("%Y/%m/%d %H:%M:%S")
    })

@app.route('/get_rockets', methods=['POST'])
def get_rockets():
    data = request.get_json()
    orbit_type = data.get('orbitType')
    target_altitude = float(data.get('targetAltitude'))
    selector = RocketSelector()
    filtered_rockets = selector.filter_rockets(target_altitude, orbit_type)
    rockets = [
        {
            'Rocket_Type': row['Rocket_Type'],
            'Launch_Site': row['Launch_Site'],
            'Launch_Site_Coordinates': f"({row['x0']}, {row['y0']}, {row['z0']})"
        } for _, row in filtered_rockets.iterrows()
    ]
    return jsonify(rockets)

@app.route('/process_trajectory', methods=['POST'])
def process_trajectory():
    try:
        data = request.get_json()
        rocket_type = data['rocketType']
        launch_site = data['launchSite']
        coords = data['launchSiteCoordinates']
        target_altitude = float(data['targetAltitude'])
        orbit_type = data['orbitType']
        timestamp = datetime.strptime(data['timestamp'], "%Y/%m/%d %H:%M:%S")
        lat, lon, alt = map(float, coords.strip("()").split(","))

        # Initial Trajectory
        traj_calc = TrajectoryCalculator()
        equations, t_climb, formulas, initial, v_orbit, burn_time = traj_calc.calculate(rocket_type, target_altitude, (lat, lon, alt))
        trajectory_data = (equations, t_climb, formulas, initial, v_orbit, burn_time)

        # Collision Detection
        detector = CollisionDetector(tle_txt_path=OUTPUT_TLE, threshold_km=1.0)
        collisions = detector.detect_collisions(equations, timestamp, t_climb)
        collisions_with_obj = [(t, pos, "Unknown Object") for t, pos in collisions] if collisions else []

        # Optimization if needed
        optimized_trajectory_data = None
        if collisions:
            optimizer = DDQLOptimizer(equations, t_climb, timestamp, OUTPUT_TLE, threshold_km=1.0)
            optimized_equations = optimizer.optimize(collisions)
            optimized_trajectory_data = (optimized_equations, t_climb, formulas, initial, v_orbit, burn_time)
            collisions = detector.detect_collisions(optimized_equations, timestamp, t_climb)
            collisions_with_obj = [(t, pos, "Unknown Object") for t, pos in collisions] if collisions else []
            final_equations = optimized_equations
            final_t_climb = t_climb
        else:
            final_equations = equations
            final_t_climb = t_climb

        # Visualization
        viz = TrajectoryVisualizer(final_equations, t_max=final_t_climb, burn_time=burn_time)
        fig = viz.plot(title=f"Trajectory to {target_altitude} km", collisions=collisions_with_obj)
        if fig is None:
            raise ValueError("Visualization failed to generate figure")
        viz_path = os.path.join(STATIC_DIR, "trajectory.html")
        fig.write_html(viz_path)

        # Report
        rocket_params = {
            'thrust_N': float(traj_calc.rocket_data[traj_calc.rocket_data['Rocket_Type'] == rocket_type]['Thrust_N'].iloc[0]),
            'mass_kg': float(traj_calc.rocket_data[traj_calc.rocket_data['Rocket_Type'] == rocket_type]['Mass_kg'].iloc[0]),
            'burn_time_s': float(traj_calc.rocket_data[traj_calc.rocket_data['Rocket_Type'] == rocket_type]['Burn_Time_s'].iloc[0])
        }
        report = MissionReport()
        report_path = report.generate(
            rocket_type=rocket_type,
            launch_site=launch_site,
            orbit_type=orbit_type,
            altitude_km=target_altitude,
            timestamp=timestamp,
            trajectory_data=trajectory_data,
            collisions=collisions_with_obj,
            rocket_params=rocket_params,
            optimized_trajectory_data=optimized_trajectory_data
        )

        with open(report_path, 'r') as f:
            report_content = f.read()

        return jsonify({
            'viz_url': '/static/trajectory.html',
            'report_content': report_content,
            'collisions': len(collisions_with_obj),
            'steps': [
                "Calculated initial trajectory",
                f"Detected {len(collisions_with_obj)} collisions",
                "Optimized trajectory" if collisions else "No optimization needed"
            ]
        })
    except Exception as e:
        print(f"Error in process_trajectory: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/report')
def report():
    report_content = request.args.get('report_content', '')
    return render_template('report.html', report_content=report_content)

if __name__ == '__main__':
    app.run(debug=True, port=5000)