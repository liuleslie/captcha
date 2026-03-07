#!/usr/bin/env python3
"""
touch.py — caress the image with your cursor.

Records mouse movement (x, y, t_ms) over an image for SVG-like playback.
Closes automatically when the cursor leaves the image window.

Usage:
    python touch.py            # interactive source picker
    python touch.py --webcam   # capture from webcam
    python touch.py --file     # open file picker

Recordings saved to: ./recordings/touch_YYYYMMDD_HHMMSS.json

Dependencies:
    pip install Pillow
    brew install ffmpeg         # only needed for --webcam
"""

import sys
import json
import time
import random
import argparse
import subprocess
import tempfile
import os
from pathlib import Path
from datetime import datetime

try:
    from PIL import Image, ImageTk
except ImportError:
    print("  missing dependency:  pip install Pillow")
    sys.exit(1)

import tkinter as tk
from tkinter import filedialog

# ── config ──────────────────────────────────────────────────────────────────

PROMPTS = [
    # clinical / captcha-toned
    "touch the item that is translucent",
    "touch the object that weighs more than the subject",
    "touch the surface that reflects the most light",
    "touch the item that casts the longest shadow",
    "touch the object that is furthest from the center",
    "touch the area that is not fully in frame",
    "touch the item that appears most recently placed",
    "touch the object that does not belong to the others",
    "touch the surface that would be cold",
    "touch the item that has an inside",

    # yearning / romantic register
    "touch the crease that would most like to be held",
    "touch the edge that leans toward you",
    "touch the part of the image that has been waiting",
    "touch what looks like it wants to be found",
    "touch the fold that remembers being opened",
    "touch the shadow that belongs to something else",
    "touch the part that is softer than it appears",
    "touch what is not quite hidden",
    "touch the place that aches a little",
    "touch the object that is furthest from home",
    "touch the thing that would notice if you left",
    "touch the edge that is still warm",
    "touch what you would reach for first",
    "touch the part the light keeps returning to",
    "touch the surface that has been touched before",
]

PROMPT_TEXT = random.choice(PROMPTS)
MAX_WIDTH     = 900          # px, image will be scaled down if wider
TRAIL_COLOR   = "#ededed"
TRAIL_RADIUS  = 2            # dot radius in px
BLINK_ON_MS   = 1500         # prompt blink cadence (ms on / ms off)
OUTPUT_DIR    = Path(__file__).parent / "recordings"

SCREENSHOT_SEARCH_DIRS = [
    Path.home() / "Desktop",
    Path.home() / "Pictures" / "Screenshots",
    Path.home() / "Documents",
]

# ── image source helpers ─────────────────────────────────────────────────────

IMAGE_EXTS = ("*.png", "*.jpg", "*.jpeg", "*.gif", "*.bmp", "*.webp")

def pick_screenshot() -> Path | None:
    candidates = []
    for d in SCREENSHOT_SEARCH_DIRS:
        if d.exists():
            for ext in IMAGE_EXTS:
                candidates.extend(
                    p for p in d.glob(ext) if p.name.startswith("Screenshot")
                )
    return random.choice(candidates) if candidates else None

def pick_any_image() -> Path | None:
    candidates = []
    for d in SCREENSHOT_SEARCH_DIRS:
        if d.exists():
            for ext in IMAGE_EXTS:
                candidates.extend(d.glob(ext))
    return random.choice(candidates) if candidates else None


def capture_webcam() -> Image.Image | None:
    fd, tmp = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        result = subprocess.run(
            ["ffmpeg", "-f", "avfoundation", "-framerate", "30", "-i", "0",
             "-frames:v", "1", "-loglevel", "error", "-y", tmp],
            capture_output=True,
        )
    except FileNotFoundError:
        print("  ffmpeg not found — brew install ffmpeg")
        return None
    if result.returncode != 0 or os.path.getsize(tmp) == 0:
        print("  webcam capture failed:")
        print(" ", result.stderr.decode().strip())
        return None
    img = Image.open(tmp).copy()
    os.unlink(tmp)
    return img


def pick_source(args, preset=None) -> tuple[Image.Image, str]:
    """Return (PIL Image, source label) based on args or interactive menu."""

    if args.webcam:
        img = capture_webcam()
        if img:
            return img, "webcam"
        print("  falling back to screenshot picker…")
        preset = "2"

    if args.file:
        root = tk.Tk(); root.withdraw()
        path = filedialog.askopenfilename(
            title="Choose an image",
            filetypes=[("Images", "*.png *.jpg *.jpeg *.gif *.bmp *.webp")]
        )
        root.destroy()
        if not path:
            sys.exit(0)
        return Image.open(path).convert("RGB"), path

    # use preset or prompt interactively
    if preset is None:
        print("\n  touch.py")
        print("  ─────────────────────────────")
        print("  1  webcam snapshot")
        print("  2  screenshot  (random Screenshot*)")
        print("  3  any image   (random from search dirs)")
        print()
        preset = input("  > ").strip()

    if preset == "1":
        img = capture_webcam()
        if img:
            return img, "webcam"
        print("  falling back to screenshot picker…")
        preset = "2"

    if preset == "2":
        path = pick_screenshot()
        if path is None:
            print("  no screenshots found in:", *SCREENSHOT_SEARCH_DIRS, sep="\n    ")
            sys.exit(1)
        print(f"  using: {path.name}")
        return Image.open(path).convert("RGB"), str(path)

    if preset == "3":
        path = pick_any_image()
        if path is None:
            print("  no images found in:", *SCREENSHOT_SEARCH_DIRS, sep="\n    ")
            sys.exit(1)
        print(f"  using: {path.name}")
        return Image.open(path).convert("RGB"), str(path)

    sys.exit(0)


# ── recorder window ──────────────────────────────────────────────────────────

class TouchRecorder:
    def __init__(self, img: Image.Image, source: str, mode: str | None = None):
        self.source      = source
        self.mode        = mode
        self.prompt_text = PROMPT_TEXT
        self.points      = []
        self.start_t     = None
        self.touching    = False

        self.root = tk.Tk()
        self.root.title("touch")
        self.root.configure(bg="black")
        self.root.resizable(False, False)

        self._load_image(img)

        # canvas
        self.canvas = tk.Canvas(
            self.root, width=self.img_w, height=self.img_h,
            highlightthickness=0, bg="black", cursor="none"
        )
        self.canvas.pack()
        self._draw_frame()

        # bindings
        self.canvas.bind("<Motion>",  self._on_motion)
        self.canvas.bind("<Button>",  self._on_click)
        self.root.bind("s",           self._on_skip)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # center on screen
        self._center_window()

    # ── canvas helpers ────────────────────────────────────────────────────

    def _load_image(self, img: Image.Image):
        """Scale img to fit MAX_WIDTH (preserving aspect ratio) and store."""
        w, h = img.size
        if w > MAX_WIDTH:
            h = int(h * MAX_WIDTH / w)
            w = MAX_WIDTH
            img = img.resize((w, h), Image.LANCZOS)
        self.img_w, self.img_h = w, h
        self.tk_img = ImageTk.PhotoImage(img)

    def _center_window(self):
        self.root.update_idletasks()
        sx, sy = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(
            f"{self.img_w}x{self.img_h}"
            f"+{(sx - self.img_w) // 2}+{(sy - self.img_h) // 2}"
        )

    def _draw_frame(self):
        """Clear canvas and redraw image + prompt. Call on init and skip."""
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor="nw", image=self.tk_img)
        cx, cy = self.img_w // 2, self.img_h // 2
        font = ("Helvetica Neue", 26, "italic")
        for dx, dy in ((-1,-1),(1,-1),(-1,1),(1,1)):
            self.canvas.create_text(cx+dx, cy+dy, text=self.prompt_text,
                                    fill="black", font=font, tags="prompt")
        self.prompt_id = self.canvas.create_text(cx, cy, text=self.prompt_text,
                                                 fill="yellow", font=font,
                                                 tags="prompt")
        self._blink()

    # ── animation ─────────────────────────────────────────────────────────

    def _blink(self):
        cur = self.canvas.itemcget("prompt", "state")
        self.canvas.itemconfig("prompt", state="hidden" if cur != "hidden" else "normal")
        self.root.after(BLINK_ON_MS, self._blink)

    # ── event handlers ─────────────────────────────────────────────────────

    def _on_motion(self, ev):
        if not self.touching:
            self.touching = True
            self.start_t  = time.monotonic()

        t_ms = int((time.monotonic() - self.start_t) * 1000)
        self.points.append({"x": ev.x, "y": ev.y, "t": t_ms})

        # draw trail dot
        r = TRAIL_RADIUS
        self.canvas.create_oval(
            ev.x - r, ev.y - r, ev.x + r, ev.y + r,
            fill=TRAIL_COLOR, outline=""
        )

    def _on_click(self, _ev):
        self._finish()

    def _on_skip(self, _):
        # re-roll prompt
        self.prompt_text = random.choice(PROMPTS)
        # re-snap / re-pick image based on mode
        new_img = None
        if self.mode == "1":
            new_img = capture_webcam()
        elif self.mode == "2":
            path = pick_screenshot()
            if path:
                self.source = str(path)
                new_img = Image.open(path).convert("RGB")
        elif self.mode == "3":
            path = pick_any_image()
            if path:
                self.source = str(path)
                new_img = Image.open(path).convert("RGB")
        if new_img:
            self._load_image(new_img)
            self.canvas.config(width=self.img_w, height=self.img_h)
            self._center_window()
        # reset recording state
        self.points   = []
        self.start_t  = None
        self.touching = False
        self._draw_frame()

    def _on_close(self):
        self._finish()

    # ── save ───────────────────────────────────────────────────────────────

    def _finish(self):
        if self.points:
            self._save()
        self.root.destroy()

    def _save(self):
        OUTPUT_DIR.mkdir(exist_ok=True)
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = OUTPUT_DIR / f"touch_{ts}.json"
        data = {
            "recorded_at": datetime.now().isoformat(),
            "prompt":      self.prompt_text,
            "source":      self.source,
            "image_size":  [self.img_w, self.img_h],
            "point_count": len(self.points),
            "duration_ms": self.points[-1]["t"] if self.points else 0,
            "points":      self.points,
        }
        out.write_text(json.dumps(data, indent=2))
        print(f"\n  saved → {out.resolve()}")
        print(f"  {len(self.points)} points  /  {data['duration_ms']} ms")

    def run(self):
        self.root.mainloop()


# ── entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Caress an image with your cursor.")
    parser.add_argument("choice", nargs="?", choices=["1", "2", "3"],
                        help="1=webcam  2=screenshot  3=file picker")
    parser.add_argument("--webcam", action="store_true")
    parser.add_argument("--file",   action="store_true")
    args = parser.parse_args()

    if args.choice == "1":
        args.webcam = True

    mode = args.choice or ("1" if args.webcam else None)
    img, source = pick_source(args, preset=args.choice)
    TouchRecorder(img, source, mode=mode).run()


if __name__ == "__main__":
    main()