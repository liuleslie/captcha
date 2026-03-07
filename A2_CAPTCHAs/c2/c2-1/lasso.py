#!/usr/bin/env python3
"""
lasso.py — hold the image with a lasso selection.

Draw a freehand selection around what you want to hold.
The marching ants will keep it company.

Controls:
    drag        draw lasso
    release     close selection (marching ants begin)
    r           reset selection, re-roll prompt (keep image)
    s           re-roll image + prompt
    close       save and quit

Recordings saved to: ./recordings/lasso_YYYYMMDD_HHMMSS.json

Dependencies:
    pip install Pillow
    brew install ffmpeg   # only needed for --webcam
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

# ── config ───────────────────────────────────────────────────────────────────

PROMPTS = [
    # tender / holding register
    "select the face you would hold",
    "lasso what you would cup in both hands",
    "draw around what is trying to leave",
    "enclose the part that is alone",
    "select what you would press to your chest",
    "lasso the part that breathes differently",
    "draw around what you would not want to lose",
    "select the face that is almost looking back",
    "enclose what is in the middle of something",
    "lasso what has the most gravity",
    "select what would fit inside your hands",
    "draw around the part that feels furthest",
    "enclose what you would recognize in the dark",
    "lasso the part that doesn't know it's being watched",
    "select what you might reach for first",
    "draw around what you came here to find",
    "enclose what aches a little",
    "lasso the thing that leans toward you",
    "select the part the light keeps returning to",

    # perverse / digital-gesture register
    "select the region that should not be selectable",
    "lasso what resists being held",
    "enclose the part that dissolves under selection",
    "draw around what you are not allowed to keep",
    "select the area that cannot be copied",
    "lasso the part that belongs to no layer",
    "draw around what selection deletes",
    "select what would remain after the cut",
    "enclose what the ants are eating",
    "lasso the part that is already gone",
    "draw around the face before it knows",
    "select what will be extracted",
    "enclose what you are about to remove",
    "lasso the part that cannot survive the clipboard",
    "draw around what is being prepared",
    "select the seam where the image ends",
    "enclose the part that belongs to someone else",
]

PROMPT_TEXT = random.choice(PROMPTS)

MAX_WIDTH    = 900
ANT_DASH     = 6          # px per marching ant segment
ANT_WIDTH    = 2
ANT_INTERVAL = 55         # ms between animation frames

FILL_COLOR   = "#ffffff"
FILL_STIPPLE = "gray25"   # ~25% opacity stipple fill over selection

LIVE_COLOR   = "#dddddd"  # color of the in-progress lasso stroke
LIVE_DASH    = (3, 4)

OUTPUT_DIR   = Path(__file__).parent / "recordings"

SCREENSHOT_SEARCH_DIRS = [
    Path.home() / "Desktop",
    Path.home() / "Pictures" / "Screenshots",
    Path.home() / "Documents",
]

# ── image source helpers ──────────────────────────────────────────────────────

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

    if preset is None:
        print("\n  lasso.py")
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


# ── lasso recorder ────────────────────────────────────────────────────────────

class LassoRecorder:
    def __init__(self, img: Image.Image, source: str, mode: str | None = None):
        self.source      = source
        self.mode        = mode
        self.prompt_text = PROMPT_TEXT
        self.lasso_pts   = []    # (x, y) pairs while drawing
        self.closed_pts  = []    # final polygon after release
        self.drawing     = False
        self.closed      = False
        self.start_t     = None
        self.end_t       = None
        self.ant_phase   = 0

        self.root = tk.Tk()
        self.root.title("lasso")
        self.root.configure(bg="black")
        self.root.resizable(False, False)

        self._load_image(img)

        self.canvas = tk.Canvas(
            self.root, width=self.img_w, height=self.img_h,
            highlightthickness=0, bg="black", cursor="crosshair"
        )
        self.canvas.pack()
        self._draw_frame()

        self.canvas.bind("<ButtonPress-1>",   self._on_press)
        self.canvas.bind("<B1-Motion>",       self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.root.bind("r", self._on_reset)
        self.root.bind("s", self._on_skip)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._center_window()
        self._tick_ants()

    # ── canvas helpers ────────────────────────────────────────────────────

    def _load_image(self, img: Image.Image):
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
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, anchor="nw", image=self.tk_img)
        cx, cy = self.img_w // 2, self.img_h // 2
        font = ("Helvetica Neue", 26, "italic")
        for dx, dy in ((-1,-1),(1,-1),(-1,1),(1,1)):
            self.canvas.create_text(cx+dx, cy+dy, text=self.prompt_text,
                                    fill="black", font=font, tags="prompt")
        self.canvas.create_text(cx, cy, text=self.prompt_text,
                                fill="yellow", font=font, tags="prompt")
        self._blink()

    # ── animation ─────────────────────────────────────────────────────────

    def _blink(self):
        if not self.drawing and not self.closed:
            cur = self.canvas.itemcget("prompt", "state")
            self.canvas.itemconfig(
                "prompt", state="hidden" if cur != "hidden" else "normal"
            )
        self.root.after(1500, self._blink)

    def _tick_ants(self):
        if self.closed and len(self.closed_pts) >= 3:
            self.ant_phase = (self.ant_phase + 1) % (ANT_DASH * 2)
            self._draw_ants()
        self.root.after(ANT_INTERVAL, self._tick_ants)

    def _draw_ants(self):
        self.canvas.delete("ants")
        pts  = self.closed_pts
        flat = [c for p in pts for c in p]

        # stipple fill over selected region
        self.canvas.create_polygon(
            flat, fill=FILL_COLOR, stipple=FILL_STIPPLE,
            outline="", tags="ants"
        )

        # two complementary dashed lines → marching ants
        d = self.ant_phase
        close = [flat[0], flat[1]]   # re-append first point to close path visually
        coords = flat + close

        self.canvas.create_line(
            *coords,
            fill="white", width=ANT_WIDTH,
            dash=(ANT_DASH, ANT_DASH), dashoffset=d,
            joinstyle="round", tags="ants"
        )
        self.canvas.create_line(
            *coords,
            fill="#1a1a1a", width=ANT_WIDTH,
            dash=(ANT_DASH, ANT_DASH), dashoffset=(d + ANT_DASH) % (ANT_DASH * 2),
            joinstyle="round", tags="ants"
        )

    def _draw_live_lasso(self):
        self.canvas.delete("live")
        if len(self.lasso_pts) < 2:
            return
        flat = [c for p in self.lasso_pts for c in p]
        self.canvas.create_line(
            *flat,
            fill=LIVE_COLOR, width=1, dash=LIVE_DASH,
            smooth=True, tags="live"
        )
        # closing ghost line back to origin
        if len(self.lasso_pts) > 4:
            ox, oy = self.lasso_pts[0]
            ex, ey = self.lasso_pts[-1]
            self.canvas.create_line(
                ex, ey, ox, oy,
                fill="#888888", width=1, dash=(2, 6),
                tags="live"
            )

    # ── event handlers ────────────────────────────────────────────────────

    def _on_press(self, ev):
        if self.closed:
            return
        self.drawing   = True
        self.lasso_pts = [(ev.x, ev.y)]
        self.start_t   = time.monotonic()
        self.canvas.itemconfig("prompt", state="hidden")

    def _on_drag(self, ev):
        if not self.drawing:
            return
        self.lasso_pts.append((ev.x, ev.y))
        self._draw_live_lasso()

    def _on_release(self, ev):
        if not self.drawing:
            return
        self.drawing = False
        self.end_t   = time.monotonic()
        if len(self.lasso_pts) < 3:
            self.lasso_pts = []
            return
        self.closed_pts = self.lasso_pts[:]  # polygon stays open internally;
        self.closed     = True               # _draw_ants closes it visually
        self.canvas.delete("live")
        self._draw_ants()

    def _on_reset(self, _):
        """r: clear selection and re-roll prompt, keep image."""
        self.prompt_text = random.choice(PROMPTS)
        self._reset_state()
        self._draw_frame()

    def _on_skip(self, _):
        """s: re-roll image and prompt."""
        self.prompt_text = random.choice(PROMPTS)
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
        self._reset_state()
        self._draw_frame()

    def _on_close(self):
        self._finish()

    # ── state ─────────────────────────────────────────────────────────────

    def _reset_state(self):
        self.lasso_pts  = []
        self.closed_pts = []
        self.drawing    = False
        self.closed     = False
        self.start_t    = None
        self.end_t      = None
        self.ant_phase  = 0
        self.canvas.delete("live")
        self.canvas.delete("ants")

    # ── save ──────────────────────────────────────────────────────────────

    def _finish(self):
        if self.closed_pts:
            self._save()
        self.root.destroy()

    def _save(self):
        OUTPUT_DIR.mkdir(exist_ok=True)
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = OUTPUT_DIR / f"lasso_{ts}.json"

        duration = (
            int((self.end_t - self.start_t) * 1000)
            if self.start_t and self.end_t else 0
        )

        data = {
            "recorded_at":  datetime.now().isoformat(),
            "prompt":       self.prompt_text,
            "source":       self.source,
            "image_size":   [self.img_w, self.img_h],
            "point_count":  len(self.closed_pts),
            "duration_ms":  duration,
            "points":       [{"x": x, "y": y} for x, y in self.closed_pts],
        }
        out.write_text(json.dumps(data, indent=2))
        print(f"\n  saved → {out.resolve()}")
        print(f"  {len(self.closed_pts)} vertices  /  {duration} ms")

    def run(self):
        self.root.mainloop()


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Hold an image with a lasso selection."
    )
    parser.add_argument("choice", nargs="?", choices=["1", "2", "3"],
                        help="1=webcam  2=screenshot  3=file picker")
    parser.add_argument("--webcam", action="store_true")
    parser.add_argument("--file",   action="store_true")
    args = parser.parse_args()

    if args.choice == "1":
        args.webcam = True

    mode = args.choice or ("1" if args.webcam else None)
    img, source = pick_source(args, preset=args.choice)
    LassoRecorder(img, source, mode=mode).run()


if __name__ == "__main__":
    main()