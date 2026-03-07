#!/usr/bin/env python3
"""
spotlight.py — paint a selection on a GAN face.

The image is dark except where your cursor illuminates it.
Paint a stroke; on release GrabCut decides the selection.
The result is shown with marching ants. Click anywhere to move
to the next face.

Controls:
    drag        paint selection hint (red overlay)
    release     algorithm expands; marching ants appear
    click       save + fetch next face
    r           reset selection, re-roll prompt (keep face)
    s           fetch new face + re-roll prompt  [blocked while drawing]
    close       save if selection made, quit

Recordings saved to: ./recordings/spot_YYYYMMDD_HHMMSS.json

Dependencies:
    pip install Pillow opencv-python requests numpy
"""

import sys
import io
import json
import time
import random
import argparse
import threading
from pathlib import Path
from datetime import datetime

try:
    from PIL import Image, ImageDraw, ImageTk
except ImportError:
    print("  missing dependency:  pip install Pillow")
    sys.exit(1)

try:
    import cv2
    import numpy as np
except ImportError:
    print("  missing dependency:  pip install opencv-python")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("  missing dependency:  pip install requests")
    sys.exit(1)

import tkinter as tk
from tkinter import filedialog

# ── config ───────────────────────────────────────────────────────────────────

PROMPTS = [
    # convincing — where the synthesis holds
    "mark what looks most alive",
    "paint what seems like it might move",
    "mark what looks like it's breathing",
    "paint what convinces you",
    "mark the most persuasive part",
    "paint where the face is most present",
    "mark what looks like it was touched",
    "paint what has the most life in it",
    "mark what looks like a person",

    # betraying — where the synthesis breaks down
    "paint the part that doesn't quite work",
    "mark what gives it away",
    "paint what's almost convincing",
    "mark where it breaks down",
    "paint what looks manufactured",
    "mark the seam",
    "paint what's not quite right",
    "mark what the model got wrong",
]

GAN_URL        = "https://thispersondoesnotexist.com/"
FACE_CACHE_DIR = Path(__file__).parent / "faces"

MAX_WIDTH        = 900
BRUSH_RADIUS     = 20
BRUSH_COLOR      = (220, 40, 40, 85)   # RGBA — red brush, semi-transparent

SPOTLIGHT_RADIUS = 160                 # px, full-brightness circle around cursor
SPOTLIGHT_DARK   = 128                 # 0–255, darkness of unlit region (128 = 50%)

ANT_DASH         = 4
ANT_WIDTH        = 1
ANT_INTERVAL     = 55                  # ms between animation frames
FILL_STIPPLE     = "gray25"

GRABCUT_ITERS    = 5
OUTPUT_DIR       = Path(__file__).parent / "recordings"

# ── GAN face fetch ────────────────────────────────────────────────────────────

def fetch_gan_face() -> tuple[Image.Image, str] | None:
    try:
        resp = requests.get(
            GAN_URL,
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        FACE_CACHE_DIR.mkdir(exist_ok=True)
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        path = FACE_CACHE_DIR / f"face_{ts}.jpg"
        img.save(path)
        return img, str(path)
    except Exception as e:
        print(f"  fetch failed: {e}")
        return None


# ── spotlight selector ────────────────────────────────────────────────────────

class SpotlightSelector:
    def __init__(self, img: Image.Image, source: str):
        self.source      = source
        self.prompt_text = random.choice(PROMPTS)

        self.stroke_pts   = []
        self.stroke_t     = []
        self.closed_pts   = []
        self.contour_area = 0

        self.drawing    = False
        self.processing = False
        self.closed     = False

        self.start_t   = None
        self.end_t     = None
        self.ant_phase = 0

        self._sel_mask_arr  = None   # numpy array: 255 inside selection, 0 outside
        self._tk_sel_lit    = None   # PhotoImage: selection visible, background masked
        self._tk_bg_lit     = None   # PhotoImage: background visible, selection masked

        self.root = tk.Tk()
        self.root.title("spotlight select")
        self.root.configure(bg="black")
        self.root.resizable(False, False)

        self._load_image(img)

        self.canvas = tk.Canvas(
            self.root, width=self.img_w, height=self.img_h,
            highlightthickness=0, bg="black", cursor="crosshair"
        )
        self.canvas.pack()
        self.img_item = self.canvas.create_image(0, 0, anchor="nw",
                                                  image=self.tk_img)
        self._draw_prompt()
        self._blink()

        self.canvas.bind("<ButtonPress-1>",   self._on_press)
        self.canvas.bind("<B1-Motion>",       self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Motion>",          self._on_motion)
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
        self.pil_img = img.convert("RGB")
        self._reset_overlay()
        self.tk_img = ImageTk.PhotoImage(self.pil_img)
        self._spotlight_cache = None   # invalidate cached gradient

    def _reset_overlay(self):
        self.overlay      = Image.new("RGBA", (self.img_w, self.img_h), (0, 0, 0, 0))
        self.overlay_draw = ImageDraw.Draw(self.overlay)

    def _refresh_display(self):
        """Composite brush overlay onto base image (used while drawing)."""
        composite = Image.alpha_composite(self.pil_img.convert("RGBA"), self.overlay)
        self.tk_img = ImageTk.PhotoImage(composite.convert("RGB"))
        self.canvas.itemconfig(self.img_item, image=self.tk_img)

    def _restore_base_display(self):
        self.tk_img = ImageTk.PhotoImage(self.pil_img)
        self.canvas.itemconfig(self.img_item, image=self.tk_img)

    def _center_window(self):
        self.root.update_idletasks()
        sx, sy = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(
            f"{self.img_w}x{self.img_h}"
            f"+{(sx - self.img_w) // 2}+{(sy - self.img_h) // 2}"
        )

    def _draw_prompt(self):
        self.canvas.delete("prompt")
        cx, cy = self.img_w // 2, int(self.img_h * 0.95)
        font = ("Helvetica Neue", 26, "italic")
        for dx, dy in ((-1,-1),(1,-1),(-1,1),(1,1)):
            self.canvas.create_text(cx+dx, cy+dy, text=self.prompt_text,
                                    fill="black", font=font, tags="prompt")
        self.canvas.create_text(cx, cy, text=self.prompt_text,
                                fill="yellow", font=font, tags="prompt")

    # ── spotlight ─────────────────────────────────────────────────────────

    def _prepare_spotlight_images(self, contour_pts):
        """Pre-compute two composites from the GrabCut mask — called once after selection.

        _tk_sel_lit  : background masked 50%, selection at full opacity
        _tk_bg_lit   : selection masked 50%, background at full opacity

        On <Motion>, a pixel lookup into _sel_mask_arr decides which to show.
        """
        flat = [c for p in contour_pts for c in p]

        mask = Image.new("L", (self.img_w, self.img_h), 0)
        ImageDraw.Draw(mask).polygon(flat, fill=255)
        self._sel_mask_arr = np.array(mask)

        base_rgba = self.pil_img.convert("RGBA")
        dark_arr  = np.zeros((self.img_h, self.img_w, 4), dtype=np.uint8)
        dark_arr[:, :, 3] = SPOTLIGHT_DARK   # black, alpha=SPOTLIGHT_DARK everywhere

        # selection lit: mask the background (alpha outside = SPOTLIGHT_DARK, inside = 0)
        bg_dark        = dark_arr.copy()
        bg_dark[:, :, 3] = np.where(self._sel_mask_arr > 127, 0, SPOTLIGHT_DARK)
        sel_lit = Image.alpha_composite(base_rgba, Image.fromarray(bg_dark, "RGBA"))
        self._tk_sel_lit = ImageTk.PhotoImage(sel_lit.convert("RGB"))

        # background lit: mask the selection (alpha inside = SPOTLIGHT_DARK, outside = 0)
        sel_dark        = dark_arr.copy()
        sel_dark[:, :, 3] = np.where(self._sel_mask_arr > 127, SPOTLIGHT_DARK, 0)
        bg_lit = Image.alpha_composite(base_rgba, Image.fromarray(sel_dark, "RGBA"))
        self._tk_bg_lit = ImageTk.PhotoImage(bg_lit.convert("RGB"))

    # ── marching ants ─────────────────────────────────────────────────────

    def _tick_ants(self):
        if self.closed and len(self.closed_pts) >= 3:
            self.ant_phase = (self.ant_phase + 1) % (ANT_DASH * 2)
            self._draw_ants()
        self.root.after(ANT_INTERVAL, self._tick_ants)

    def _draw_ants(self):
        self.canvas.delete("ants")
        flat  = [c for p in self.closed_pts for c in p]
        close = [flat[0], flat[1]]
        coords = flat + close

        d = self.ant_phase
        self.canvas.create_line(
            *coords, fill="white", width=ANT_WIDTH,
            dash=(ANT_DASH, ANT_DASH), dashoffset=d,
            joinstyle="round", tags="ants"
        )
        self.canvas.create_line(
            *coords, fill="#1a1a1a", width=ANT_WIDTH,
            dash=(ANT_DASH, ANT_DASH), dashoffset=(d + ANT_DASH) % (ANT_DASH * 2),
            joinstyle="round", tags="ants"
        )

    # ── animation ─────────────────────────────────────────────────────────

    def _blink(self):
        if not self.drawing and not self.processing and not self.closed:
            cur = self.canvas.itemcget("prompt", "state")
            self.canvas.itemconfig(
                "prompt", state="hidden" if cur != "hidden" else "normal"
            )
        self.root.after(1500, self._blink)

    def _show_status(self, text):
        self.canvas.delete("status")
        cx, cy = self.img_w // 2, self.img_h // 2
        self.canvas.create_rectangle(cx - 90, cy - 18, cx + 90, cy + 18,
                                     fill="black", outline="", tags="status")
        self.canvas.create_text(cx, cy, text=text, fill="#666666",
                                font=("Helvetica Neue", 13), tags="status")

    def _hide_status(self):
        self.canvas.delete("status")

    # ── brush painting ────────────────────────────────────────────────────

    def _paint_brush(self, x, y):
        r = BRUSH_RADIUS
        self.overlay_draw.ellipse([x-r, y-r, x+r, y+r], fill=BRUSH_COLOR)
        self._refresh_display()

    # ── GrabCut ───────────────────────────────────────────────────────────

    def _run_grabcut(self) -> list[tuple[int, int]]:
        img_bgr = cv2.cvtColor(np.array(self.pil_img), cv2.COLOR_RGB2BGR)
        h, w = img_bgr.shape[:2]
        mask = np.full((h, w), cv2.GC_PR_BGD, dtype=np.uint8)
        for x, y in self.stroke_pts:
            cv2.circle(mask, (x, y), BRUSH_RADIUS, cv2.GC_FGD, -1)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        try:
            cv2.grabCut(img_bgr, mask, None, bgd, fgd,
                        GRABCUT_ITERS, cv2.GC_INIT_WITH_MASK)
        except cv2.error:
            return []
        fg = np.where(
            (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 1, 0
        ).astype(np.uint8)
        contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL,
                                        cv2.CHAIN_APPROX_TC89_L1)
        if not contours:
            return []
        largest = max(contours, key=cv2.contourArea)
        self.contour_area = int(cv2.contourArea(largest))
        return [(int(p[0][0]), int(p[0][1])) for p in largest]

    def _grabcut_thread(self):
        pts = self._run_grabcut()
        self.root.after(0, lambda: self._on_grabcut_done(pts))

    def _on_grabcut_done(self, contour_pts):
        self.processing = False
        self._hide_status()
        self._reset_overlay()
        self._restore_base_display()

        if contour_pts and len(contour_pts) >= 3:
            self.closed_pts = contour_pts
            self.closed     = True
            self.canvas.itemconfig("prompt", state="hidden")
            self._prepare_spotlight_images(contour_pts)
            # start with background lit (selection dimmed) until cursor moves
            self.canvas.itemconfig(self.img_item, image=self._tk_bg_lit)
        else:
            self._show_status("no subject found — try again")
            self.root.after(2000, self._hide_status)

    # ── event handlers ────────────────────────────────────────────────────

    def _on_press(self, ev):
        if self.closed:
            # save and fetch next face
            self._save()
            self._next_face()
            return
        if self.processing:
            return
        self.drawing    = True
        self.start_t    = time.monotonic()
        self.stroke_pts = [(ev.x, ev.y)]
        self.stroke_t   = [0]
        self.canvas.itemconfig("prompt", state="hidden")
        self._paint_brush(ev.x, ev.y)

    def _on_drag(self, ev):
        if not self.drawing:
            return
        t = int((time.monotonic() - self.start_t) * 1000)
        self.stroke_pts.append((ev.x, ev.y))
        self.stroke_t.append(t)
        self._paint_brush(ev.x, ev.y)

    def _on_release(self, ev):
        if not self.drawing:
            return
        self.drawing    = False
        self.end_t      = time.monotonic()
        self.processing = True
        self._show_status("selecting…")
        threading.Thread(target=self._grabcut_thread, daemon=True).start()

    def _on_motion(self, ev):
        if not self.closed or self._sel_mask_arr is None:
            return
        x = max(0, min(ev.x, self.img_w - 1))
        y = max(0, min(ev.y, self.img_h - 1))
        inside = self._sel_mask_arr[y, x] > 127
        img = self._tk_sel_lit if inside else self._tk_bg_lit
        self.canvas.itemconfig(self.img_item, image=img)

    def _on_reset(self, _):
        if self.processing or self.drawing:
            return
        self.prompt_text = random.choice(PROMPTS)
        self._reset_state()
        self._restore_base_display()
        self._draw_prompt()

    def _on_skip(self, _):
        if self.processing or self.drawing:
            return
        self.prompt_text = random.choice(PROMPTS)
        self._show_status("fetching…")
        threading.Thread(target=self._fetch_thread, daemon=True).start()

    def _fetch_thread(self):
        result = fetch_gan_face()
        self.root.after(0, lambda: self._on_fetch_done(result))

    def _on_fetch_done(self, result):
        self._hide_status()
        if result:
            new_img, new_source = result
            self.source = new_source
            self._load_image(new_img)
            self.canvas.config(width=self.img_w, height=self.img_h)
            self._center_window()
            self.canvas.itemconfig(self.img_item, image=self.tk_img)
        self._reset_state()
        self._draw_prompt()

    def _on_close(self):
        self._finish()

    # ── next face ─────────────────────────────────────────────────────────

    def _next_face(self):
        self._show_status("fetching…")
        threading.Thread(target=self._fetch_thread, daemon=True).start()

    # ── state ─────────────────────────────────────────────────────────────

    def _reset_state(self):
        self.stroke_pts   = []
        self.stroke_t     = []
        self.closed_pts   = []
        self.contour_area = 0
        self.drawing      = False
        self.processing   = False
        self.closed       = False
        self.start_t      = None
        self.end_t        = None
        self.ant_phase      = 0
        self._sel_mask_arr  = None
        self._tk_sel_lit    = None
        self._tk_bg_lit     = None
        self._reset_overlay()
        self.canvas.delete("ants")
        self.canvas.delete("status")
        self.canvas.delete("prompt")

    # ── save ──────────────────────────────────────────────────────────────

    def _finish(self):
        if self.closed_pts:
            self._save()
        self.root.destroy()

    def _save(self):
        OUTPUT_DIR.mkdir(exist_ok=True)
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = OUTPUT_DIR / f"spot_{ts}.json"

        duration = (
            int((self.end_t - self.start_t) * 1000)
            if self.start_t and self.end_t else 0
        )

        data = {
            "recorded_at":     datetime.now().isoformat(),
            "prompt":          self.prompt_text,
            "source":          self.source,
            "image_size":      [self.img_w, self.img_h],
            "brush_radius":    BRUSH_RADIUS,
            "duration_ms":     duration,
            "stroke":          [{"x": x, "y": y, "t": t}
                                 for (x, y), t in zip(self.stroke_pts, self.stroke_t)],
            "contour":         [{"x": x, "y": y} for x, y in self.closed_pts],
            "contour_area_px": self.contour_area,
        }
        out.write_text(json.dumps(data, indent=2))
        print(f"\n  saved → {out.resolve()}")
        print(f"  stroke: {len(self.stroke_pts)} pts  /  contour: {len(self.closed_pts)} pts")

    def run(self):
        self.root.mainloop()


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Spotlight selection on GAN faces."
    )
    parser.add_argument("--file", action="store_true",
                        help="use a local image instead of fetching from GAN")
    args = parser.parse_args()

    if args.file:
        root = tk.Tk(); root.withdraw()
        path = filedialog.askopenfilename(
            title="Choose an image",
            filetypes=[("Images", "*.png *.jpg *.jpeg *.gif *.bmp *.webp")]
        )
        root.destroy()
        if not path:
            sys.exit(0)
        img    = Image.open(path).convert("RGB")
        source = path
    else:
        print("  fetching face…")
        result = fetch_gan_face()
        if not result:
            print("  network unavailable — use --file")
            sys.exit(1)
        img, source = result

    SpotlightSelector(img, source).run()


if __name__ == "__main__":
    main()