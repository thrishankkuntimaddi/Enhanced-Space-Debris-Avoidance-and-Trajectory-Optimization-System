"""Render the mission-control voice clips for the game.

    KOKORO_DIR=/path/to/kokoro <venv-with-kokoro-onnx>/bin/python tools/callouts.py

Voices: Kokoro-82M (Apache-2.0, offline neural TTS, github.com/thewh1teagle/kokoro-onnx). KOKORO_DIR
holds kokoro-v1.0.onnx and voices-v1.0.bin. Needs ffmpeg.

Writes src/interface/static/sf/audio/vo/*.mp3 and manifest.json. The game applies the
ground-loop or space-to-ground radio processing itself (game/audio.js), so the clips are dry.

Roles:
  fd  Flight director: runs the go/no-go poll, then CAPCOM on the radio loop after orbit.
  st  Station consoles answering the poll (weather, range, propulsion ...), alternating voices.
  ld  Launch director: the count and the ascent calls, one voice per launch provider.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "src/interface/static/sf/audio/vo"

FD_VOICE = ("af_heart", "en-us", 1.05)
ST_VOICES = [("am_adam", "en-us", 1.08), ("af_bella", "en-us", 1.08)]
LD_VOICES = {                       # provider -> (voice, language, speed)
    "spacex": ("am_michael", "en-us", 1.05),
    "isro": ("hm_omega", "en-us", 1.0),
    "roscosmos": ("bm_george", "en-gb", 1.02),
    "arianespace": ("bf_emma", "en-gb", 1.05),
    "rocketlab": ("bm_lewis", "en-gb", 1.05),
}

FD = {
    "fd_poll": "All stations, this is Flight. Stand by for the go, no-go poll.",
    "fd_weather": "Weather?",
    "fd_range": "Range?",
    "fd_prop": "Propulsion?",
    "fd_guid": "Guidance?",
    "fd_health": "Vehicle health?",
    "fd_cola": "Sentinel, collision avoidance?",
    "fd_go": "Launch director, Flight is go for launch.",
    "fd_red_ack": "Copy, Sentinel. Launch director, your call.",
    # CAPCOM, space-to-ground (radio-processed in the game)
    "cc_orbit": "Orbit insertion confirmed. Welcome to space.",
    "cc_conj_red": "Conjunction warning. Red. A tracked object is closing on our orbit.",
    "cc_conj_amber": "Heads up. Amber conjunction ahead.",
    "cc_sentinel": "Sentinel has a burn solution. Verified against the full catalog.",
    "cc_burn": "Avoidance burn. Executing now.",
    "cc_clear": "Close approach passed. We are clear.",
    "cc_frag": "Warning. Fragmentation event. New debris on our track.",
    "cc_payload": "Payload separation confirmed. Good deploy.",
    "cc_deorbit": "Deorbit burn complete. The stage is headed for a safe reentry.",
    "cc_collision": "Collision. We have loss of signal.",
    "cc_success": "Mission success. Great flying.",
    "cc_horizon": "End of the screening horizon. Deploy the payload and dispose of the stage.",
}
ST = {
    "st_weather_go": "Weather is go.",
    "st_range_go": "Range is go.",
    "st_prop_go": "Propulsion is go.",
    "st_guid_go": "Guidance is go. Flight computer has the trajectory.",
    "st_health_go": "All systems nominal. Vehicle health is good.",
    "st_cola_go": "Sentinel is go. The launch window is clear.",
    "st_cola_amber": "Sentinel is go. One amber conjunction, inside limits.",
    "st_cola_red": "Sentinel is no-go. Red conjunction on this plan.",
}
LD = {
    "copy": "Copy. We are go for launch. Resuming the terminal count.",
    "t10": "T minus ten.",
    **{f"n{k}": w for k, w in zip(range(9, 0, -1), ["Nine.", "Eight.", "Seven.", "Six.", "Five.", "Four.", "Three.", "Two.", "One."])},
    "tower": "Vehicle has cleared the tower.",
    "pitch": "Pitch program. Vehicle is heading downrange.",
    "super": "Vehicle is supersonic.",
    "maxq": "Max Q. Peak aerodynamic pressure on the vehicle.",
    "beco": "Booster engine cutoff.",
    "bsep": "Booster separation.",
    "meco": "Main engine cutoff.",
    "ssep": "Stage separation confirmed.",
    "ses": "Upper stage ignition.",
    "fairing": "Fairing separation.",
    "guid": "Closed loop guidance has the vehicle.",
    "nominal": "Telemetry nominal. Trajectory is right on the line.",
    "seco": "Engine cutoff. We are in the transfer orbit.",
    "circ": "Circularization burn is underway.",
    "lost": "We have lost the vehicle.",
}
LIFTOFF = {   # vehicle id -> (provider, words)
    "electron": ("rocketlab", "Zero. Liftoff! Liftoff of Electron."),
    "falcon9": ("spacex", "Zero. Liftoff! Liftoff of Falcon 9."),
    "falconheavy": ("spacex", "Zero. Liftoff! Liftoff of Falcon Heavy."),
    "soyuz": ("roscosmos", "Zero. Liftoff. Soyuz is on its way."),
    "pslv": ("isro", "Zero. Liftoff! P S L V has lifted off from Sriharikota."),
    "ariane64": ("arianespace", "Zero. Liftoff! Liftoff of Ariane 6."),
}
SIDE_BOOSTERS = {"spacex": "Side booster separation."}   # Falcon Heavy wording


_TTS = None


def render(text: str, voice: tuple[str, str, float], dest: Path, tmp: Path) -> float:
    global _TTS
    import soundfile as sf
    from kokoro_onnx import Kokoro
    if _TTS is None:
        d = Path(os.environ.get("KOKORO_DIR", "kokoro"))
        _TTS = Kokoro(str(d / "kokoro-v1.0.onnx"), str(d / "voices-v1.0.bin"))
    audio, sr = _TTS.create(text, voice=voice[0], lang=voice[1], speed=voice[2])
    raw = tmp / (dest.stem + ".wav")
    sf.write(raw, audio, sr)
    af = ("silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
          "silenceremove=start_periods=1:start_threshold=-50dB,areverse,"
          "highpass=f=90,loudnorm=I=-16:TP=-1.5:LRA=7")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-af", af, "-ac", "1", "-ar", "24000",
                    "-c:a", "libmp3lame", "-b:a", "56k", str(dest)], check=True)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(dest)],
                         capture_output=True, text=True, check=True)
    return round(float(out.stdout.strip()), 3)


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("needs ffmpeg")
    OUT.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[str, str, tuple]] = []
    jobs += [(k, t, FD_VOICE) for k, t in FD.items()]
    jobs += [(k, t, ST_VOICES[i % 2]) for i, (k, t) in enumerate(ST.items())]
    for prov, voice in LD_VOICES.items():
        for k, t in LD.items():
            if k == "bsep":
                t = SIDE_BOOSTERS.get(prov, t)
            jobs.append((f"ld_{prov}_{k}", t, voice))
    for vid, (prov, t) in LIFTOFF.items():
        jobs.append((f"liftoff_{vid}", t, LD_VOICES[prov]))
    clips = {}
    with tempfile.TemporaryDirectory() as td:
        for key, text, voice in jobs:
            dur = render(text, voice, OUT / f"{key}.mp3", Path(td))
            clips[key] = {"file": f"{key}.mp3", "dur": dur, "text": text}
            print(f"{key:28s} {dur:5.2f}s  {text}")
    (OUT / "manifest.json").write_text(json.dumps({"providers": list(LD_VOICES), "clips": clips}, indent=1))
    print(f"{len(clips)} clips -> {OUT}")


if __name__ == "__main__":
    main()
