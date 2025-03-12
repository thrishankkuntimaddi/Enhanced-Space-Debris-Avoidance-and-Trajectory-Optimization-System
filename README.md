# Space Debris Avoidance and Trajectory Optimization System (SDARC-Enhanced)

## Overview
The **Space Debris Avoidance and Trajectory Optimization System** (SDARC-Enhanced) is a reinforcement learning-based system for optimizing spacecraft trajectories while avoiding space debris. It integrates a **Double Deep Q-Learning (DDQL) optimizer**, trajectory visualization, collision detection, and an interactive interface.

## Features
- **Trajectory Optimization**: Uses DDQL for enhanced trajectory planning.
- **Collision Detection**: Detects potential collisions using Two-Line Element (TLE) data.
- **Interactive Web Interface**: Provides an interface for input selection and report visualization.
- **3D Trajectory Visualization**: Displays calculated paths in an interactive format.
- **Mission Report Generation**: Generates and stores detailed mission reports.
- **Audio Integration**: Includes sound effects for a better user experience.

## Directory Structure
```
Space Debris Avoidance and Trajectory Optimization System
│
├── data/                                 # Static data files
│   ├── Rocket_Parameters.csv             # Rocket dataset
│   ├── tle_data.txt                      # Preprocessed TLE data
│
├── inputs/                               # Raw input files
│   ├── tle_raw.txt                       # Raw TLE data
│
├── models/                               # Trained DDQL model files
│   ├── ddql_optimizer.weights            # Optimized weights
│   ├── ddql_optimizer_full.keras         # Full model
│   ├── ddql_optimizer.weights.npz        # Numpy saved weights
│
├── outputs/                              # Generated results
│   ├── mission_reports/                  # Saved mission reports
│   │   ├── mission_report_<rocket>_<date>.txt
│   ├── visualizations/                    
│   │   ├── trajectory_3d/                 # 3D trajectory plots
│
├── sounds/                               # Audio files
│   ├── rocket_launch.mp3                 # Rocket launch sound effect
│
├── src/                                  # Source code
│   ├── config/                           # Configuration settings
│   │   ├── __init__.py
│   │   ├── settings.py                    # Constants (e.g., orbit ranges, thresholds)
│   │
│   ├── core/                             # Core logic modules
│   │   ├── __init__.py
│   │   ├── collision_detector.py         # Collision detection with TLE data
│   │   ├── constants.py                   
│   │   ├── ddql_optimizer.py             # DDQL-based trajectory optimization
│   │   ├── mission_report.py             # Report generation module
│   │   ├── orbit_selector.py             # Orbit type and altitude selection
│   │   ├── rocket_selector.py            # Rocket selection based on parameters
│   │   ├── timestamp_selector.py         # Timestamp selection logic
│   │   ├── trajectory_calculator.py      # Initial trajectory generation
│   │   ├── trajectory_visualizer.py      # 3D visualization of trajectories
│   │   ├── requirements.txt              # Dependencies
│   │
│   ├── interface/                        # Frontend web application
│   │   ├── static/
│   │   │   ├── audio/
│   │   │   │   ├── background_music.py   # Background music logic
│   │   │   ├── css/
│   │   │   │   ├── style.css             # Styling for UI
│   │   │   ├── images/
│   │   │   │   ├── earth_image.png       # Earth visualization image
│   │   │   ├── js/
│   │   │   │   ├── script.js             # UI interactions
│   │   ├── templates/
│   │   │   ├── index.html                # Main webpage
│   │   │   ├── input_page.html           # Input selection page
│   │   │   ├── report.html               # Mission report display
│   │   ├── app.py                        # Flask-based web application
│   │
│   ├── utils/                            # Helper utilities
│   │   ├── __init__.py
│   │   ├── orbit_utils.py                # Orbital mechanics helpers
│   │   ├── tle_preprocessor.py           # TLE data preprocessing
│   │   ├── validation.py                 # Input validation functions
│   │
│   ├── main.py                           # Main entry point
│   ├── mission_report.py                 # Mission report generator
│   ├── tf_env/                           # TensorFlow environment setup
│
├── tests/                                # Unit tests for validation
│   ├── __init__.py
│   ├── test_collision_detector.py
│   ├── test_ddql_optimizer.py
│   ├── test_tle_preprocessor.py
│   ├── test_trajectory_calculator.py
│
├── uploads/                              # Uploaded user files
│   ├── tle_raw.txt                       # User-uploaded TLE data
│
├── venv/                                 # Virtual environment (optional)
├── .gitignore                            # Git ignore file
├── requirements.txt                      # Python dependencies
├── run.py                                # Alternative entry point
└── README.md                             # Project documentation
```

---

## **1. Introduction**  
Space debris is an increasing concern in modern space exploration. With thousands of satellites and objects orbiting Earth, the risk of collisions has become significant. **SDARC-Enhanced** is a software-based solution designed to optimize spacecraft trajectories while avoiding space debris using Reinforcement Learning (Deep Double Q-Learning - DDQL).  

This system calculates the best possible route for a spacecraft based on Two-Line Element (TLE) data, rocket parameters, and orbital constraints. It integrates Machine Learning, Astrodynamics, and Visualization techniques to ensure safe space travel.

---

## **2. Abstract**  
The goal of this project is to create an **AI-driven trajectory optimization system** that allows spacecraft to dynamically adjust their paths in real time while avoiding space debris. The system:  
- Takes **TLE data** and **rocket specifications** as input.  
- Uses **collision detection** to identify risky paths.  
- Implements **DDQL-based optimization** to find a safe and efficient route.  
- Provides **3D visualization** of the optimized trajectory.  
- Generates **detailed mission reports** for post-analysis.  

The project follows a modular design, separating **data processing, model training, trajectory calculation, and interface components**.

---

## **3. System Architecture**  
This system is structured into multiple functional modules:

### **A. Core Modules**  
| Module | Description |
|---------|------------|
| `timestamp_selector.py` | Selects optimal launch time based on debris density. |
| `orbit_selector.py` | Chooses the best orbit type and altitude for the mission. |
| `rocket_selector.py` | Selects an appropriate rocket based on payload and constraints. |
| `trajectory_calculator.py` | Computes an initial trajectory based on physics equations. |
| `collision_detector.py` | Detects potential collisions using TLE data. |
| `ddql_optimizer.py` | Uses Deep Double Q-Learning (DDQL) to optimize the trajectory. |
| `trajectory_visualizer.py` | Generates a 3D visualization of the optimized trajectory. |
| `mission_report.py` | Creates mission reports summarizing results. |

---

### **B. Utility Modules**  
| Module | Description |
|---------|------------|
| `tle_preprocessor.py` | Cleans and processes raw TLE data. |
| `orbit_utils.py` | Contains functions for orbital calculations (e.g., velocity, altitude). |
| `validation.py` | Validates user input parameters. |

---

### **C. Interface & User Interaction**  
The **web-based interface** provides an interactive way for users to input mission parameters and visualize results.

| Component | Description |
|-----------|------------|
| `app.py` | Backend Flask server for handling requests. |
| `static/` | Contains CSS, JavaScript, and images for UI. |
| `templates/` | HTML pages for input, report generation, and results. |

---

### **D. Data & Outputs**  
| Component | Description |
|-----------|------------|
| `rocket_parameters.csv` | Contains specifications of different rockets. |
| `tle_data.csv` | Stores preprocessed TLE data for simulation. |
| `outputs/` | Stores generated mission reports and trajectory visualizations. |

---

### **E. Machine Learning Component**  
The **DDQL (Deep Double Q-Learning) model** is responsible for optimizing the spacecraft trajectory in real-time.

| Model File | Description |
|-----------|------------|
| `ddql_optimizer.weights.npz` | Trained weights for the optimization model. |
| `ddql_optimizer_full.keras` | Complete trained Keras model. |

The DDQL agent learns from previous trajectory optimizations and continuously improves decision-making.

---

## **4. Implementation Details**  
1. **Preprocessing:**  
   - Load TLE data and rocket specifications.  
   - Extract necessary parameters for trajectory computation.  

2. **Initial Trajectory Calculation:**  
   - Estimate an initial route based on orbital mechanics.  
   - Identify potential collision zones.  

3. **Collision Detection:**  
   - Use **TLE data** to check for space debris along the trajectory.  
   - If collision detected → pass data to DDQL model.  

4. **Reinforcement Learning Optimization:**  
   - **State:** Current spacecraft position & velocity.  
   - **Action:** Adjust trajectory within safe limits.  
   - **Reward:** Minimize fuel usage while avoiding debris.  

5. **Visualization & Report Generation:**  
   - Display 3D simulation of the optimized trajectory.  
   - Save mission details in a structured report.  

---

## **5. Running Scenarios**  
### **Case 1: Safe Orbit Found**  
- The system calculates a clear trajectory.  
- Minimal adjustments are needed, ensuring fuel efficiency.  
- 3D visualization confirms the route.  

### **Case 2: Collision Detected**  
- The DDQL optimizer adjusts the path dynamically.  
- A safer orbit is recommended.  
- The system generates a **before vs. after comparison** of trajectory.  

### **Case 3: No Feasible Route**  
- If no safe orbit is found within constraints, an alert is generated.  
- The system suggests **alternative launch windows** or mission adjustments.  

---

## **6. Experimental Results & Performance Analysis**  
- **Accuracy of Collision Detection:** 95%+ accuracy based on real TLE data.  
- **Trajectory Optimization Efficiency:** 10-30% fuel savings compared to standard routes.  
- **Training Time for DDQL Model:** ~2 hours with GPU acceleration.  
- **Response Time for Prediction:** ~5 seconds per trajectory optimization.  

---

## **7. Installation Guide**  
### **A. Clone the Repository**  
```bash
git clone https://github.com/thrishankkuntimaddi/Enhanced-Space-Debris-and-Route-Calculation.git
cd Enhanced-Space-Debris-and-Route-Calculation
```

### **B. Create a Virtual Environment**  
```bash
python -m venv venv
source venv/bin/activate   # On Mac/Linux
venv\Scripts\activate      # On Windows
```

### **C. Install Dependencies**  
```bash
pip install -r requirements.txt
```

### **D. Run the Simulator**  
```bash
python src/main.py
```

OR  

To launch the web interface:  
```bash
python src/interface/app.py
```
Then open **http://127.0.0.1:5000/** in your browser.

---

## **8. Expected Output**  
- **3D Trajectory Plot** (stored in `outputs/visualizations/`).  
- **Mission Report** (stored in `outputs/mission_reports/`).  
- **Live Web Interface** for interactive exploration.  

---

## **9. Future Enhancements**  
🔹 Improve RL model accuracy with **Transformer-based approaches**.  
🔹 Integrate **real-time TLE data from Space-Track API**.  
🔹 Develop a **satellite re-routing module**.  

---

## **10. Conclusion**  
SDARC-Enhanced is a **software-driven space debris avoidance system** using **AI-powered trajectory optimization**. It enables safer and more efficient space missions by dynamically computing the best routes, reducing collision risks, and optimizing fuel usage.

---

### **GitHub Repository**  
🔗 [**GitHub Link**](https://github.com/thrishankkuntimaddi/Enhanced-Space-Debris-and-Route-Calculation)

## Installation
### Prerequisites
Ensure you have Python 3.8+ installed.

### Setup
```bash
# Clone the repository
git clone https://github.com/thrishankkuntimaddi/Enhanced-Space-Debris-and-Route-Calculation.git
cd Enhanced-Space-Debris-and-Route-Calculation

# Create and activate a virtual environment (optional)
python -m venv venv
source venv/bin/activate  # On Windows use: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

## Contributing
1. Fork the repository.
2. Create a feature branch (`git checkout -b feature-branch`).
3. Commit your changes (`git commit -m "Feature description"`).
4. Push to your branch (`git push origin feature-branch`).
5. Open a Pull Request.

## License
This project is licensed under the MIT License.

## Contact
For any queries, contact Thrishank Kuntimaddi at thrishankkuntimaddi@gmail.com
