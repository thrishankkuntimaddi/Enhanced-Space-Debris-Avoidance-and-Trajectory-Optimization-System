# src/core/ddql_optimizer.py
import numpy as np
from datetime import datetime
import random
from collections import deque
import tensorflow as tf
from tensorflow.keras import layers, optimizers
from src.core.collision_detector import CollisionDetector
import os

class DDQLOptimizer:
    def __init__(self, equations, t_max, timestamp, tle_data_path, threshold_km=1.0, learning_rate=0.001,
                 discount_factor=0.95, exploration_rate=1.0, exploration_decay=0.995):
        self.equations = equations.copy()
        self.t_max = t_max
        self.timestamp = timestamp
        self.tle_data_path = tle_data_path
        self.threshold_km = threshold_km
        self.detector = CollisionDetector(tle_txt_path=tle_data_path, threshold_km=threshold_km)
        self.learning_rate = learning_rate
        self.discount_factor = discount_factor
        self.exploration_rate = exploration_rate
        self.exploration_decay = exploration_decay
        self.state_size = 6  # [rocket_x, y, z, nearest_debris_x, y, z]
        self.action_size = 5  # Actions: [no change, +x vel, -x vel, +y vel, -y vel]
        self.memory = deque(maxlen=10000)
        self.model = self._build_model()
        self.target_model = self._build_model()
        self.update_target_model()
        self.checkpoint_dir = "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/models/"
        self.checkpoint_path = os.path.join(self.checkpoint_dir, "ddql_optimizer_weights.npz")

        if os.path.exists(self.checkpoint_path):
            try:
                weights = np.load(self.checkpoint_path, allow_pickle=True)
                self.model.set_weights([weights[f'arr_{i}'] for i in range(len(weights))])
                print("Loaded checkpoint weights successfully from .npz.")
            except Exception as e:
                print(f"Failed to load checkpoint weights: {e}")
                print("Starting with fresh model weights.")
        else:
            print("No checkpoint found. Starting fresh.")

    def _build_model(self):
        model = tf.keras.Sequential([
            layers.Input(shape=(self.state_size,)),
            layers.Dense(128, activation='relu'),
            layers.Dense(64, activation='relu'),
            layers.Dense(self.action_size, activation='linear')
        ])
        model.compile(loss='mse', optimizer=optimizers.Adam(learning_rate=self.learning_rate))
        return model

    def update_target_model(self):
        self.target_model.set_weights(self.model.get_weights())

    def _get_state(self, t):
        rocket_pos = self.detector._rocket_position(self.equations, t)
        debris_positions = self.detector._debris_positions(self.timestamp, t)
        if not debris_positions:
            nearest_debris = np.zeros(3)
        else:
            distances = [np.linalg.norm(rocket_pos - d) for d in debris_positions]
            nearest_idx = np.argmin(distances)
            nearest_debris = debris_positions[nearest_idx]
        state = np.concatenate([rocket_pos, nearest_debris])
        return state

    def _apply_action(self, action):
        new_equations = self.equations.copy()
        if action == 1:  # +x vel
            new_equations['x'] = new_equations['x'].replace('5649.37', str(5649.37 * 1.1))
        elif action == 2:  # -x vel
            new_equations['x'] = new_equations['x'].replace('5649.37', str(5649.37 * 0.9))
        elif action == 3:  # +y vel
            new_equations['y'] = new_equations['y'].replace('5258.77', str(5258.77 * 1.1))
        elif action == 4:  # -y vel
            new_equations['y'] = new_equations['y'].replace('5258.77', str(5258.77 * 0.9))
        return new_equations

    def optimize(self, collisions, episodes=50, max_steps=100):
        if not collisions:
            print("No collisions to optimize.")
            return self.equations

        print(f"Optimizing trajectory to avoid {len(collisions)} collisions...")
        for episode in range(episodes):
            state = self._get_state(0)
            total_reward = 0
            current_equations = self.equations.copy()

            for step in range(max_steps):
                t = step * (self.t_max / max_steps)
                if random.uniform(0, 1) < self.exploration_rate:
                    action = random.randrange(self.action_size)
                else:
                    q_values = self.model.predict(state[np.newaxis, :], verbose=0)
                    action = np.argmax(q_values[0])

                new_equations = self._apply_action(action)
                new_collisions = self.detector.detect_collisions(new_equations, self.timestamp, self.t_max)
                reward = -100 * len(new_collisions) + 10 if not new_collisions else -100 * len(new_collisions)
                done = step == max_steps - 1 or not new_collisions
                next_state = self._get_state(t)

                self.memory.append((state, action, reward, next_state, done))
                if len(self.memory) > 32:
                    self._replay(32)

                state = next_state
                total_reward += reward
                current_equations = new_equations if len(new_collisions) < len(collisions) else current_equations

                if done:
                    break

            self.exploration_rate = max(0.1, self.exploration_rate * self.exploration_decay)
            if episode % 10 == 0:
                self.update_target_model()
            print(f"Episode {episode + 1}/{episodes}, Reward: {total_reward}, Collisions: {len(self.detector.detect_collisions(current_equations, self.timestamp, self.t_max))}")

        # Save weights as .npz
        os.makedirs(self.checkpoint_dir, exist_ok=True)
        try:
            weights = self.model.get_weights()
            # Debug: Check for zero-sized weights
            for i, w in enumerate(weights):
                if w.size == 0:
                    print(f"Warning: Weight {i} has size 0: {w.shape}")
            np.savez(self.checkpoint_path, *weights)
            print(f"Saved model weights to {self.checkpoint_path}")
        except Exception as e:
            print(f"Failed to save weights: {e}")

        final_collisions = self.detector.detect_collisions(current_equations, self.timestamp, self.t_max)
        print(f"Optimization complete. Final collisions: {len(final_collisions)}")
        return current_equations

    def _replay(self, batch_size):
        minibatch = random.sample(self.memory, batch_size)
        states = np.array([m[0] for m in minibatch])
        actions = np.array([m[1] for m in minibatch])
        rewards = np.array([m[2] for m in minibatch])
        next_states = np.array([m[3] for m in minibatch])
        dones = np.array([m[4] for m in minibatch])

        targets = self.model.predict(states, verbose=0)
        next_q_values = self.target_model.predict(next_states, verbose=0)
        for i in range(batch_size):
            targets[i][actions[i]] = rewards[i] + self.discount_factor * np.max(next_q_values[i]) * (1 - dones[i])
        self.model.fit(states, targets, epochs=1, verbose=0)

if __name__ == "__main__":
    test_equations = {
        'x': '-39.261 + 5649.37 * t',
        'y': '177.864 + 5258.77 * t',
        'z': '0 + 2074.13 * t**2 if t <= 80 else 13279360.0'
    }
    test_timestamp = datetime(2025, 3, 1, 12, 0, 0)
    test_collisions = [(5.0, np.array([100, 200, 300]))]
    optimizer = DDQLOptimizer(test_equations, 15.54, test_timestamp,
                              "/Users/thrishankkuntimaddi/Documents/Projects/SDARC-Enhanced/data/tle_data.txt")
    optimized_equations = optimizer.optimize(test_collisions)
    print(f"Optimized trajectory: {optimized_equations}")