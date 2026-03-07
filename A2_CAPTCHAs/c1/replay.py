#!/usr/bin/env python3
"""
replay.py — render a touch recording as animated HTML or GIF.

Usage:
    python replay.py                           # latest recording → .html
    python replay.py recordings/touch_XYZ.json
    python replay.py --gif                     # render as animated GIF instead
    python replay.py --embed                   # bake source image into HTML

Dependencies:
    pip install Pillow    # only needed for --gif
"""

import sys
import json
import argparse
import subprocess
import base64
from pathlib import Path

RECORDINGS_DIR = Path(__file__).parent / "recordings"


# ── helpers ───────────────────────────────────────────────────────────────────

def pick_latest() -> Path:
    recordings = sorted(RECORDINGS_DIR.glob("touch_*.json"),
                        key=lambda p: p.stat().st_mtime)
    if not recordings:
        print("  no recordings found in", RECORDINGS_DIR)
        sys.exit(1)
    return recordings[-1]


def embed_image(source: str) -> str | None:
    p = Path(source)
    if not p.exists():
        return None
    suffix = p.suffix.lower().lstrip(".")
    mime = {"jpg": "jpeg", "jpeg": "jpeg"}.get(suffix, suffix)
    data = base64.b64encode(p.read_bytes()).decode()
    return f"data:image/{mime};base64,{data}"


# ── HTML output ───────────────────────────────────────────────────────────────

def build_html(data: dict, embed: bool) -> str:
    w, h    = data["image_size"]
    pts     = data["points"]
    dur_s   = data["duration_ms"] / 1000
    max_t   = data["duration_ms"]
    source  = data.get("source", "")

    # static trail path
    d_parts = [f"M {pts[0]['x']},{pts[0]['y']}"]
    for p in pts[1:]:
        d_parts.append(f"L {p['x']},{p['y']}")
    path_d = " ".join(d_parts)

    # sample keyframes (≤500 for file size)
    step    = max(1, len(pts) // 500)
    sampled = pts[::step]
    if sampled[-1] is not pts[-1]:
        sampled.append(pts[-1])
    key_times  = ";".join(f"{p['t'] / max_t:.4f}" for p in sampled)
    key_values = ";".join(f"{p['x']},{p['y']}"    for p in sampled)

    bg_layer = ""
    if embed and source not in ("webcam", ""):
        uri = embed_image(source)
        if uri:
            bg_layer = f'    <image href="{uri}" x="0" y="0" width="{w}" height="{h}"/>'

    source_label = Path(source).name if source not in ("webcam", "") else source
    prompt       = data.get("prompt", "")

    svg = f"""  <svg xmlns="http://www.w3.org/2000/svg"
       width="{w}" height="{h}" viewBox="0 0 {w} {h}">
    <rect width="{w}" height="{h}" fill="black"/>
{bg_layer}
    <path d="{path_d}"
          fill="none" stroke="white" stroke-width="1.5" opacity="0.25"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle r="3" fill="white" opacity="0.9">
      <animateMotion
          dur="{dur_s:.3f}s"
          repeatCount="indefinite"
          calcMode="linear"
          keyTimes="{key_times}"
          values="{key_values}"/>
    </circle>
    <text x="{w // 2}" y="32"
          font-family="Helvetica Neue, sans-serif" font-size="15"
          font-style="italic" fill="white" opacity="0.55"
          text-anchor="middle">
      {prompt}
    </text>
    <text x="10" y="{h - 10}"
          font-family="monospace" font-size="11" fill="#444">
      {source_label} · {len(pts)} pts · {dur_s:.2f}s
    </text>
  </svg>"""

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>touch replay</title>
  <style>
    html, body {{ margin: 0; background: black; display: flex;
                  justify-content: center; align-items: center;
                  min-height: 100vh; }}
  </style>
</head>
<body>
{svg}
</body>
</html>"""


# ── GIF output ────────────────────────────────────────────────────────────────

def build_gif(data: dict, out_path: Path):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("  missing dependency:  pip install Pillow")
        sys.exit(1)

    w, h   = data["image_size"]
    pts    = data["points"]
    dur_ms = data["duration_ms"]
    source = data.get("source", "")

    # background
    try:
        bg = Image.open(source).convert("RGB").resize((w, h), Image.LANCZOS)
    except Exception:
        bg = Image.new("RGB", (w, h), "black")

    fps       = 20
    frame_ms  = 1000 // fps
    n_frames  = min(300, dur_ms // frame_ms + 1)

    trail     = bg.copy()   # accumulates the dot trail
    frames    = []
    pt_idx    = 0

    for f in range(n_frames):
        t_target = f * frame_ms

        # advance trail dots up to this frame's time
        while pt_idx < len(pts) and pts[pt_idx]["t"] <= t_target:
            p = pts[pt_idx]
            r = 2
            d = ImageDraw.Draw(trail)
            d.ellipse([p["x"]-r, p["y"]-r, p["x"]+r, p["y"]+r], fill="white")
            pt_idx += 1

        # frame = trail snapshot + cursor dot
        frame = trail.copy()
        if pt_idx > 0:
            cp = pts[pt_idx - 1]
            r  = 5
            ImageDraw.Draw(frame).ellipse(
                [cp["x"]-r, cp["y"]-r, cp["x"]+r, cp["y"]+r], fill="white"
            )

        frames.append(frame.convert("P", palette=Image.ADAPTIVE, dither=0))

    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=frame_ms,
        loop=0,
        optimize=False,
    )
    print(f"  {n_frames} frames @ {fps}fps")


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Replay a touch recording.")
    parser.add_argument("recording", nargs="?", help="path to .json recording")
    parser.add_argument("--gif",   action="store_true", help="output animated GIF")
    parser.add_argument("--embed", action="store_true", help="embed source image (HTML only)")
    args = parser.parse_args()

    path = Path(args.recording) if args.recording else pick_latest()
    print(f"  replaying: {path.name}")

    data = json.loads(path.read_text())

    if args.gif:
        out = path.with_suffix(".gif")
        build_gif(data, out)
    else:
        out = path.with_suffix(".html")
        out.write_text(build_html(data, embed=args.embed))

    print(f"  saved → {out.resolve()}")
    subprocess.run(["open", str(out)])


if __name__ == "__main__":
    main()