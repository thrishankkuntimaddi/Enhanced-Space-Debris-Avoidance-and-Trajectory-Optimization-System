import numpy as np
import math
import pandas as pd
import random
from collections import deque
import tensorflow as tf
from tensorflow.keras import layers, optimizers
from sklearn.metrics import f1_score, accuracy_score, precision_score, recall_score
import matplotlib.pyplot as plt
import os

class DeepDynamicCollisionDetection:
    def __init__(self, trajectory_equation, rocket_type, launch_sites, launch_coordinates, altitude, altitude_range, orbit_type, time_selected, tle_data, learning_rate=0.0003, discount_factor=0.99, exploration_rate=1.0, exploration_decay=0.995, state_size=3, action_size=10):
        # Initialization
        self.trajectory_equation = trajectory_equation
        self.rocket_type = rocket_type
        self.launch_sites = launch_sites
        self.launch_coordinates = launch_coordinates
        self.altitude = altitude
        self.altitude_range = altitude_range
        self.orbit_type = orbit_type
        self.time_selected = time_selected
        self.tle_data = pd.read_csv(tle_data) if isinstance(tle_data, str) else tle_data  # Ensure tle_data is a DataFrame
        self.learning_rate = learning_rate
        self.discount_factor = discount_factor
        self.exploration_rate = exploration_rate
        self.exploration_decay = exploration_decay
        self.state_size = state_size
        self.action_size = action_size
        self.memory = deque(maxlen=15000)  # Increased replay memory to store more diverse experiences
        self.actions = [(0, 0), (10, 0), (0, 10), (-10, 0), (5, 5), (-5, -5), (10, 10), (-10, -10), (15, 0), (0, 15)]  # Action space
        self.model = self._build_model()
        self.target_model = self._build_model()  # Target network for stable learning
        self.update_target_model()  # Initialize target model with the same weights as the model
        self.x_cumulative_adjust = 0
        self.y_cumulative_adjust = 0
        self.episode_rewards = []
        self.collision_avoided = []
        self.true_labels = []
        self.predicted_labels = []
        self.collision_data = []  # Track collision events
        self.checkpoint_path = "/Users/thrishankkuntimaddi/Documents/Final_Year_Project/Space-Debris-and-Route-Calculation/checkpoints/deep_dynamic_collision_detection.weights.h5"  # Path to save checkpoints

        # Load model weights if available
        if os.path.exists(self.checkpoint_path):
            self.model.load_weights(self.checkpoint_path)
            print("Checkpoint loaded successfully. Using existing model for predictions.")
        else:
            print("No checkpoint found, training from scratch.")

    def _build_model(self):
        # Improved neural network for Deep Q-Learning
        model = tf.keras.Sequential()
        model.add(layers.Input(shape=(self.state_size,)))
        model.add(layers.Dense(512, activation='relu'))  # Increased neurons for deeper learning
        model.add(layers.Dense(256, activation='relu'))
        model.add(layers.Dense(128, activation='relu'))
        model.add(layers.Dropout(0.3))  # Increased dropout rate for better regularization
        model.add(layers.Dense(self.action_size, activation='linear'))
        model.compile(loss='mse', optimizer=optimizers.Adam(learning_rate=self.learning_rate))
        return model

    def update_target_model(self):
        # Update target model with weights from the main model
        self.target_model.set_weights(self.model.get_weights())

    def rocket_position(self, t):
        # Calculate the rocket's position using the given trajectory equations
        try:
            x = eval(self.trajectory_equation['x'].replace('x(t) = ', '').replace('t', f'({t})'), {'cos': math.cos, 'sin': math.sin, 'exp': math.exp})
            y = eval(self.trajectory_equation['y'].replace('y(t) = ', '').replace('t', f'({t})'), {'cos': math.cos, 'sin': math.sin, 'exp': math.exp})
            z = eval(self.trajectory_equation['z'].replace('z(t) = ', '').replace('t', f'({t})'), {'cos': math.cos, 'sin': math.sin, 'exp': math.exp})
            return np.array([x, y, z])
        except Exception as e:
            print(f"Error calculating rocket position: {e}")
            return np.array([np.nan, np.nan, np.nan])

    def satellite_positions(self, t):
        # Calculate satellite positions based on TLE data and time t
        positions = []
        for _, row in self.tle_data.iterrows():
            try:
                inclination = row['Inclination_deg']
                raan = row['RAAN_deg']
                eccentricity = row['Eccentricity'] * 1e-7
                mean_motion = row['Mean_Motion']
                # Simple approximation for satellite position based on mean motion and time t
                x = inclination * math.cos(raan + mean_motion * t)
                y = inclination * math.sin(raan + mean_motion * t)
                z = eccentricity * math.sin(mean_motion * t)
                positions.append(np.array([x, y, z]))  # Updated to reflect changing positions over time
            except Exception as e:
                print(f"Error calculating satellite position: {e}")
        return positions

    @staticmethod
    def detect_collision(rocket_position, satellite_positions, threshold=1.0):
        # Detect collision by calculating distances
        for sat_pos in satellite_positions:
            distance = np.linalg.norm(rocket_position - sat_pos)
            if distance < threshold:
                return True  # Collision detected
        return False

    def get_state(self, t):
        # Generate a simplified state representation based on the rocket's position at time t
        rocket_pos = self.rocket_position(t)
        print(f"Debug: Rocket position at time {t}: {rocket_pos}")  # Debug statement for rocket position
        return np.zeros(self.state_size) if np.any(np.isnan(rocket_pos)) else np.round(rocket_pos, 2)

    def train(self, num_episodes=None, max_steps=None):
        if num_episodes is None:
            num_episodes = int(input("Enter total number of episodes: "))
        if max_steps is None:
            max_steps = int(input("Enter max_steps: "))

        # Train the model using Deep Q-learning with Double DQN and Target Network
        for episode in range(num_episodes):
            state = self.get_state(0)  # Initial state
            total_reward = 0
            collisions_avoided = 0
            collision_count = 0  # Counter to track collisions per episode

            for t in range(1, max_steps):
                # Choose action: exploration or exploitation
                if random.uniform(0, 1) < self.exploration_rate:
                    action = random.randrange(self.action_size)
                else:
                    q_values = self.model.predict(state[np.newaxis, :])
                    print(f"Debug: Q-values for state {state}: {q_values}")  # Debug statement for Q-values
                    action = np.argmax(q_values[0])

                # Apply action and calculate new state
                t_adjust, y_adjust = self.actions[action]
                print(f"Debug: Action taken: {action}, t_adjust: {t_adjust}, y_adjust: {y_adjust}")  # Debug statement for action
                self.x_cumulative_adjust += t_adjust
                self.y_cumulative_adjust += y_adjust
                new_state = self.get_state(t)

                # Calculate reward
                rocket_pos = self.rocket_position(t)
                satellite_pos = self.satellite_positions(t)
                if self.detect_collision(rocket_pos, satellite_pos):
                    reward = random.randint(-250, -150)  # Increased penalty for collision with variability to enhance class diversity
                    done = True
                    collision_count += 1  # Increment collision counter
                    self.collision_data.append((t, rocket_pos.tolist()))  # Log collision data
                else:
                    reward = random.randint(10, 30)  # Increased and variable reward for safe trajectory to enhance diversity
                    done = False

                # Store experience in replay memory
                self.memory.append((state, action, reward, new_state, done))

                # Train the model using replay
                if len(self.memory) > 64:
                    self.replay(64)

                state = new_state
                total_reward += reward

                # Track if collision was avoided
                if reward > 0:
                    collisions_avoided += 1
                    self.true_labels.append(1)
                    self.predicted_labels.append(1 if action != 0 else 0)
                else:
                    self.true_labels.append(1)
                    self.predicted_labels.append(0)

                if done:
                    break

            # Update target model every 10 episodes
            if episode % 10 == 0:
                self.update_target_model()

            # Decay exploration rate
            if self.exploration_rate > 0.1:
                self.exploration_rate *= (self.exploration_decay ** 0.9)  # Slower decay to encourage more exploration

            print(f"Episode {episode + 1} total reward: {total_reward}")
            print(f"Total collisions detected in this episode: {collision_count}")  # Debug statement for collisions
            self.episode_rewards.append(total_reward)
            self.collision_avoided.append(collisions_avoided / max_steps)

            print(f"Episode: {episode + 1}/{num_episodes}, Total Reward: {total_reward}, Epsilon: {self.exploration_rate}, Collisions Avoided: {collisions_avoided}/{max_steps}")

            # Save model weights after training step
            self.model.save_weights(self.checkpoint_path)

        # Evaluation Metrics
        evaluation_metrics = self.evaluate_model(forced=True)
        print("Training completed.")
        return evaluation_metrics, self.collision_data, self.optimize_trajectory()

    def replay(self, batch_size):
        minibatch = random.sample(self.memory, batch_size)
        for state, action, reward, next_state, done in minibatch:
            target = reward
            if not done:
                target += self.discount_factor * np.amax(self.target_model.predict(next_state[np.newaxis, :])[0])
            target_f = self.model.predict(state[np.newaxis, :])
            target_f[0][action] = target
            print(f"Debug: Target for action {action}: {target}")  # Debug statement for target value
            self.model.fit(state[np.newaxis, :], target_f, epochs=1, verbose=0)

    def evaluate_model(self, forced=False):
        # Calculate evaluation metrics
        average_reward = np.mean(self.episode_rewards) if len(self.episode_rewards) > 0 else 0.0
        collision_avoidance_rate = np.mean(self.collision_avoided) if len(self.collision_avoided) > 0 else 0.0
        accuracy = accuracy_score(self.true_labels, self.predicted_labels) if len(self.true_labels) > 0 and len(
            set(self.true_labels)) > 1 else 0.0
        f1 = f1_score(self.true_labels, self.predicted_labels) if len(self.true_labels) > 0 and len(
            set(self.true_labels)) > 1 else 0.0
        precision = precision_score(self.true_labels, self.predicted_labels) if len(self.true_labels) > 0 and len(
            set(self.true_labels)) > 1 else 0.0
        recall = recall_score(self.true_labels, self.predicted_labels) if len(self.true_labels) > 0 and len(
            set(self.true_labels)) > 1 else 0.0

        print(f"Average Reward: {average_reward}")
        print(f"Collision Avoidance Rate: {collision_avoidance_rate}")
        print(f"Accuracy: {accuracy}")
        print(f"Precision: {precision}")
        print(f"Recall: {recall}")
        print(f"F1 Score: {f1}")

        return {
            'average_reward': average_reward,
            'collision_avoidance_rate': collision_avoidance_rate,
            'accuracy': accuracy,
            'precision': precision,
            'recall': recall,
            'f1_score': f1
        }

    def optimize_trajectory(self):
        # Apply cumulative adjustments to the trajectory equation
        self.trajectory_equation['x'] = f"{self.trajectory_equation['x']} + {self.x_cumulative_adjust}"
        self.trajectory_equation['y'] = f"{self.trajectory_equation['y']} + {self.y_cumulative_adjust}"

        # Return the optimized trajectory after training
        return self.trajectory_equation

    def predict(self, t):
        # Use the trained model to predict the action for a given state
        state = self.get_state(t)
        q_values = self.model.predict(state[np.newaxis, :])
        action = np.argmax(q_values[0])
        print(f"Predicted action for time {t}: {action}")
        return action
