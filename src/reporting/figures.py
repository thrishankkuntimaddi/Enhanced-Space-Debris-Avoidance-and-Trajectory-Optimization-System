# src/reporting/figures.py
"""Evidence figures written to artifacts/ (light-mode PNG, one axis per panel)."""
from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from src.config import settings as S

BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
INK, INK2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e7e6e2", "#fcfcfb"


def _style(ax, title, xlabel, ylabel):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=11, color=INK, fontweight="bold")
    ax.set_xlabel(xlabel, color=INK2, fontsize=9)
    ax.set_ylabel(ylabel, color=INK2, fontsize=9)
    ax.grid(True, color=GRID, linewidth=0.8)
    ax.tick_params(colors=INK2, labelsize=8)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)


def _label_end(ax, x, y, text, color, dy=0):
    ax.annotate(text, (x, y), xytext=(6, dy), textcoords="offset points", va="center", fontsize=8, color=INK2)
    ax.plot([x], [y], "o", ms=5, color=color, mec=SURFACE, mew=1.5)


def prediction_error_figure():
    v = json.loads((S.ARTIFACTS_DIR / "propagation_validation.json").read_text())
    rows = v["by_regime"]["LEO"]
    mids = [np.mean([float(a) for a in r["horizon_h"].split("-")]) for r in rows]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4), facecolor=SURFACE)
    ax = axes[0]
    _style(ax, "LEO prediction error vs horizon (3-D)", "prediction horizon (h)", "position error (km, log)")
    for key, color, name in (("median_km", BLUE, "median"), ("p90_km", ORANGE, "p90")):
        y = [r[key] for r in rows]
        ax.plot(mids, y, color=color, lw=2)
        _label_end(ax, mids[-1], y[-1], name, color)
    ax.set_yscale("log")
    ax = axes[1]
    _style(ax, "Median |error| by RTN component", "prediction horizon (h)", "km")
    for key, color, name, dy in (("median_abs_along_km", BLUE, "along-track", 0),
                                 ("median_abs_radial_km", ORANGE, "radial", 7),
                                 ("median_abs_cross_km", AQUA, "cross-track", -7)):
        y = [r[key] for r in rows]
        ax.plot(mids, y, color=color, lw=2)
        _label_end(ax, mids[-1], y[-1], name, color, dy)
    for a in axes:
        a.set_xlim(0, max(mids) * 1.25)
    fig.text(0.01, 0.01, f"{v['pairs']:,} back-test pairs; older TLE propagated to newer TLE epoch with SGP4",
             fontsize=8, color=INK2)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    fig.savefig(S.ARTIFACTS_DIR / "fig_prediction_error.png", dpi=150)
    plt.close(fig)


def training_figure():
    logs = {}
    for name, label in (("ddqn", "Double DQN"), ("dqn", "DQN (vanilla)")):
        p = S.ARTIFACTS_DIR / f"training_{name}.json"
        if p.exists():
            logs[label] = json.loads(p.read_text())
    if not logs:
        return
    colors = {"Double DQN": BLUE, "DQN (vanilla)": ORANGE}
    fig, axes = plt.subplots(1, 3, figsize=(14, 3.8), facecolor=SURFACE)
    specs = [("safe_rate", "Validation safe rate (no RED)", "fraction", 100),
             ("mean_return", "Validation mean return", "return", 1),
             ("overestimation", "Q overestimation: Q(s0) − actual return", "gap", 1)]
    for ax, (key, title, ylabel, scale) in zip(axes, specs):
        _style(ax, title, "training episode", ylabel)
        for label, log in logs.items():
            ev = log["evals"]
            x = [e["ep"] for e in ev]
            y = [e[key] for e in ev]
            ax.plot(x, y, color=colors[label], lw=2, label=label)
            ax.plot(x[-1:], y[-1:], "o", ms=5, color=colors[label], mec=SURFACE, mew=1.5)
        if key == "overestimation":
            ax.axhline(0, color=INK2, lw=0.8, ls="--")
    axes[0].legend(frameon=False, fontsize=8, labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(S.ARTIFACTS_DIR / "fig_training.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    prediction_error_figure()
    training_figure()
