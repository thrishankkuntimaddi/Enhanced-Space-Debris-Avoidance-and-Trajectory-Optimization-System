class MissionReport:
    def __init__(self):
        self.report_data = {
            "mission_overview": {},
            "rocket_details": {},
            "initial_trajectory_info": {},
            "optimized_trajectory_info": {},
            "collision_detection_summary": {},
            "orbital_analysis": {},
            "mission_planning": {},
            "evaluation_summary": {},
            "conclusion": {},
            "evaluation_metrics": {}  # Added evaluation metrics section
        }

    def add_mission_overview(self, mission_name, orbit_details, launch_window):
        self.report_data["mission_overview"] = {
            "mission_name": mission_name,
            "orbit_details": orbit_details,
            "launch_window": launch_window
        }

    def add_rocket_details(self, rocket_type, fuel_consumption, compatible_launch_sites, launch_site_coordinates):
        self.report_data["rocket_details"] = {
            "rocket_type": rocket_type,
            "fuel_consumption": fuel_consumption,
            "compatible_launch_sites": compatible_launch_sites,
            "launch_site_coordinates": launch_site_coordinates
        }

    def add_initial_trajectory_info(self, trajectory_equation, parameters, visualization_notes):
        self.report_data["initial_trajectory_info"] = {
            "trajectory_equation": trajectory_equation,
            "parameters": parameters,
            "visualization_notes": visualization_notes
        }

    def add_optimized_trajectory_info(self, optimized_trajectory_equation, visualization_notes):
        self.report_data["optimized_trajectory_info"] = {
            "optimized_trajectory_equation": optimized_trajectory_equation,
            "visualization_notes": visualization_notes
        }

    def add_collision_detection_summary(self, detection_methods, detected_events, dynamic_analysis_notes):
        self.report_data["collision_detection_summary"] = {
            "detection_methods": detection_methods,
            "detected_events": detected_events,
            "dynamic_analysis_notes": dynamic_analysis_notes
        }

    def add_orbital_analysis(self, selected_orbit, feasibility_analysis, orbital_velocity):
        self.report_data["orbital_analysis"] = {
            "selected_orbit": selected_orbit,
            "feasibility_analysis": feasibility_analysis,
            "orbital_velocity": orbital_velocity
        }

    def add_mission_planning(self, user_inputs, mission_criteria, optimal_conditions):
        self.report_data["mission_planning"] = {
            "user_inputs": user_inputs,
            "mission_criteria": mission_criteria,
            "optimal_conditions": optimal_conditions
        }

    def add_evaluation_summary(self, evaluation_criteria, performance_metrics, recommended_method):
        self.report_data["evaluation_summary"] = {
            "evaluation_criteria": evaluation_criteria,
            "performance_metrics": performance_metrics,
            "recommended_method": recommended_method
        }

    def add_conclusion(self, readiness_assessment, recommendations):
        self.report_data["conclusion"] = {
            "readiness_assessment": readiness_assessment,
            "recommendations": recommendations
        }

    def add_evaluation_metrics(self, average_reward, collision_avoidance_rate, accuracy, f1, precision, recall):
        self.report_data["evaluation_metrics"] = {
            "average_reward_per_episode": average_reward,
            "average_collision_avoidance_rate": f"{collision_avoidance_rate * 100:.2f}%",
            "accuracy": f"{accuracy * 100:.2f}%",
            "f1_score": f"{f1:.2f}",
            "precision": f"{precision:.2f}",
            "recall": f"{recall:.2f}"
        }

    def generate_report(self):
        # This method prints or writes the full mission report to a file
        report_str = "\nMISSION REPORT\n\n"
        for section, content in self.report_data.items():
            if content:  # Only include sections with content
                report_str += f"{section.upper().replace('_', ' ')}:\n"
                for key, value in content.items():
                    report_str += f"  {key.replace('_', ' ').title()}: {value}\n"
                report_str += "\n"
        return report_str

    def save_report_to_file(self, filename="mission_report.txt"):
        with open(filename, "w") as file:
            file.write(self.generate_report())
