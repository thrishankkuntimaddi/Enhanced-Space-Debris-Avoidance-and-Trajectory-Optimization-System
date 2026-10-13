# src/rl/ddqn.py
"""
Double Deep Q-Network (van Hasselt et al. 2016) with a dueling head (Wang et al. 2016).

Why Double DQN: the vanilla DQN target  r + g * max_a' Q_target(s', a')  uses the same
(noisy) estimates to both SELECT and EVALUATE the next action, so it is biased upward.
Double DQN decouples them:
      a* = argmax_a' Q_online(s', a')          (select with the online net)
      y  = r + g * Q_target(s', a*)            (evaluate with the target net)
Setting double=False gives vanilla DQN, which we train as an ablation.

Other choices: Huber loss, Adam, gradient-norm clipping, soft (Polyak) target updates,
invalid-action masking in both acting and bootstrapping.
"""
from __future__ import annotations

import random
from collections import deque

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class QNet(nn.Module):
    def __init__(self, state_dim: int, n_actions: int, hidden: int = 256, dueling: bool = True):
        super().__init__()
        self.dueling = dueling
        self.body = nn.Sequential(nn.Linear(state_dim, hidden), nn.ReLU(),
                                  nn.Linear(hidden, hidden), nn.ReLU())
        if dueling:
            self.value = nn.Linear(hidden, 1)
            self.adv = nn.Linear(hidden, n_actions)
        else:
            self.head = nn.Linear(hidden, n_actions)

    def forward(self, x):
        h = self.body(x)
        if self.dueling:
            a = self.adv(h)
            return self.value(h) + a - a.mean(dim=1, keepdim=True)
        return self.head(h)


class ReplayBuffer:
    def __init__(self, capacity: int):
        self.buf = deque(maxlen=capacity)

    def push(self, *transition):
        self.buf.append(transition)

    def sample(self, n: int):
        batch = random.sample(self.buf, n)
        s, a, r, s2, d, m2 = map(np.array, zip(*batch))
        return (torch.as_tensor(s, dtype=torch.float32), torch.as_tensor(a, dtype=torch.int64),
                torch.as_tensor(r, dtype=torch.float32), torch.as_tensor(s2, dtype=torch.float32),
                torch.as_tensor(d, dtype=torch.float32), torch.as_tensor(m2, dtype=torch.bool))

    def __len__(self):
        return len(self.buf)


class DDQNAgent:
    def __init__(self, state_dim: int, n_actions: int, double: bool = True, dueling: bool = True,
                 lr: float = 3e-4, gamma: float = 0.97, tau: float = 0.01, buffer: int = 100_000,
                 batch_size: int = 128, hidden: int = 256, seed: int = 0):
        torch.manual_seed(seed); random.seed(seed); np.random.seed(seed)
        self.n_actions, self.gamma, self.tau, self.batch_size = n_actions, gamma, tau, batch_size
        self.double, self.dueling, self.hidden = double, dueling, hidden
        self.online = QNet(state_dim, n_actions, hidden, dueling)
        self.target = QNet(state_dim, n_actions, hidden, dueling)
        self.target.load_state_dict(self.online.state_dict())
        self.opt = torch.optim.Adam(self.online.parameters(), lr=lr)
        self.memory = ReplayBuffer(buffer)
        self.losses: list[float] = []

    @torch.no_grad()
    def q_values(self, s: np.ndarray) -> np.ndarray:
        return self.online(torch.as_tensor(s[None], dtype=torch.float32))[0].numpy()

    def act(self, s: np.ndarray, mask: np.ndarray, eps: float = 0.0) -> int:
        if random.random() < eps:
            return int(random.choice(np.flatnonzero(mask)))
        q = self.q_values(s)
        q[~mask] = -np.inf
        return int(np.argmax(q))

    def learn(self) -> float | None:
        if len(self.memory) < max(self.batch_size, 1000):
            return None
        s, a, r, s2, d, m2 = self.memory.sample(self.batch_size)
        q = self.online(s).gather(1, a[:, None]).squeeze(1)
        with torch.no_grad():
            q_t = self.target(s2).masked_fill(~m2, -1e9)
            if self.double:
                a_star = self.online(s2).masked_fill(~m2, -1e9).argmax(1, keepdim=True)
                q_next = q_t.gather(1, a_star).squeeze(1)
            else:
                q_next = q_t.max(1).values
            y = r + self.gamma * (1 - d) * q_next
        loss = F.smooth_l1_loss(q, y)
        self.opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.online.parameters(), 10.0)
        self.opt.step()
        with torch.no_grad():
            for p, tp in zip(self.online.parameters(), self.target.parameters()):
                tp.mul_(1 - self.tau).add_(self.tau * p)
        self.losses.append(float(loss.detach()))
        return self.losses[-1]

    def export_numpy(self, path) -> None:
        """Serving artifact: plain numpy arrays so the web app needs no PyTorch."""
        sd = {k: v.detach().cpu().numpy() for k, v in self.online.state_dict().items()}
        np.savez(path, dueling=np.array(self.dueling), **{k.replace(".", "__"): v for k, v in sd.items()})

    def save(self, path) -> None:
        torch.save({"online": self.online.state_dict(), "double": self.double,
                    "dueling": self.dueling, "hidden": self.hidden}, path)
