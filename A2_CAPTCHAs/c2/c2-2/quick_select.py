#!/usr/bin/env python3
"""
quick_select.py — paint what you want to keep.

Paint a brush stroke over a GAN-generated face. On release, GrabCut
decides what you actually selected. The piece lifts from the image
and follows your cursor. Click to drop it.

Controls:
    drag        paint selection hint (red overlay)
    release     algorithm expands; piece sticks to cursor
    click       drop the piece, save, reset for new selection
    r           reset without saving (keep face, re-roll prompt)
    s           fetch new face + re-roll prompt  [blocked while drawing]
    close       save if piece is floating, quit

Recordings saved to: ./recordings/qsel_YYYYMMDD_HHMMSS.json

Dependencies:
    pip install Pillow opencv-python requests
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
    "mark what looks like it’s breathing",
    "paint what convinces you",
    "mark the most persuasive part",
    "paint where the face is most present",
    "mark what looks like it was touched",
    "paint what has the most life in it",
    "mark what looks like a person",

    # betraying — where the synthesis breaks down
    "paint the part that doesn’t quite work",
    "mark what gives it away",
    "paint what’s almost convincing",
    "mark where it breaks down",
    "paint what looks manufactured",
    "mark the seam",
    "paint what’s not quite right",
    "mark what the model got wrong",
]

GAN_URL        = "https://thispersondoesnotexist.com/"
FACE_CACHE_DIR = Path(__file__).parent / "faces"

MAX_WIDTH     = 900
BRUSH_RADIUS  = 20
BRUSH_COLOR   = (220, 40, 40, 85)    # RGBA — red brush, semi-transparent

HOLE_FILL     = (0, 0, 0, 250)       # darkening left behind when piece lifts

GRABCUT_ITERS = 5
OUTPUT_DIR    = Path(__file__).parent / "recordings"

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


# ── quick selector ────────────────────────────────────────────────────────────

class QuickSelector:
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
        self.floating   = False

        self.start_t   = None
        self.end_t     = None
        self.release_x = self.release_y = 0

        self.float_img      = None
        self.float_tk       = None
        self.float_anchor_x = 0
        self.float_anchor_y = 0
        self.float_final_x  = None
        self.float_final_y  = None

        self.root = tk.Tk()
        self.root.title("quick select")
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

    def _reset_overlay(self):
        self.overlay      = Image.new("RGBA", (self.img_w, self.img_h), (0, 0, 0, 0))
        self.overlay_draw = ImageDraw.Draw(self.overlay)

    def _refresh_display(self):
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
        cx, cy = self.img_w // 2, (self.img_h * 0.95) 
        font = ("Helvetica Neue", 26, "italic")
        for dx, dy in ((-1,-1),(1,-1),(-1,1),(1,1)):
            self.canvas.create_text(cx+dx, cy+dy, text=self.prompt_text,
                                    fill="black", font=font, tags="prompt")
        self.canvas.create_text(cx, cy, text=self.prompt_text,
                                fill="yellow", font=font, tags="prompt")

    # ── animation ─────────────────────────────────────────────────────────

    def _blink(self):
        if not self.drawing and not self.processing and not self.closed and not self.floating:
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

        if contour_pts and len(contour_pts) >= 3:
            self.closed_pts = contour_pts
            self.closed     = True
            self._start_floating(contour_pts)
        else:
            self._restore_base_display()
            self._show_status("no subject found — try again")
            self.root.after(2000, self._hide_status)

    # ── floating piece ────────────────────────────────────────────────────

    def _start_floating(self, contour_pts):
        flat = [c for p in contour_pts for c in p]

        # mask from contour
        mask_img = Image.new("L", (self.img_w, self.img_h), 0)
        ImageDraw.Draw(mask_img).polygon(flat, fill=255)
        bbox = mask_img.getbbox()
        if not bbox:
            self._restore_base_display()
            return

        # extract the piece as RGBA
        rgba = self.pil_img.convert("RGBA")
        rgba.putalpha(mask_img)
        self.float_img = rgba.crop(bbox)
        self.float_tk  = ImageTk.PhotoImage(self.float_img)

        # darken the vacated region on the base image
        hole = Image.new("RGBA", (self.img_w, self.img_h), (0, 0, 0, 0))
        ImageDraw.Draw(hole).polygon(flat, fill=HOLE_FILL)
        base = Image.alpha_composite(self.pil_img.convert("RGBA"), hole)
        self.tk_img = ImageTk.PhotoImage(base.convert("RGB"))
        self.canvas.itemconfig(self.img_item, image=self.tk_img)

        # anchor: release point relative to the crop's top-left
        self.float_anchor_x = self.release_x - bbox[0]
        self.float_anchor_y = self.release_y - bbox[1]

        # place at origin (bbox[0], bbox[1]) — will follow cursor on <Motion>
        self.canvas.delete("float")
        self.canvas.create_image(
            bbox[0], bbox[1], anchor="nw",
            image=self.float_tk, tags="float"
        )
        self.floating = True
        self.canvas.config(cursor="fleur")

    # ── event handlers ────────────────────────────────────────────────────

    def _on_press(self, ev):
        if self.floating:
            # drop: record position, save, reset for next selection
            self.float_final_x = ev.x - self.float_anchor_x
            self.float_final_y = ev.y - self.float_anchor_y
            self._save()
            self._reset_state()
            self._restore_base_display()
            self._draw_prompt()
            return
        if self.processing or self.closed:
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
        self.release_x  = ev.x
        self.release_y  = ev.y
        self.processing = True
        self._show_status("selecting…")
        threading.Thread(target=self._grabcut_thread, daemon=True).start()

    def _on_motion(self, ev):
        if not self.floating:
            return
        items = self.canvas.find_withtag("float")
        if items:
            self.canvas.coords(items[0],
                               ev.x - self.float_anchor_x,
                               ev.y - self.float_anchor_y)

    def _on_reset(self, _):
        if self.processing or self.drawing:
            return
        self.prompt_text = random.choice(PROMPTS)
        self._reset_state()
        self._restore_base_display()
        self._draw_prompt()

    def _on_skip(self, _):
        if self.processing or self.drawing:   # blocked while drawing
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

    # ── state ─────────────────────────────────────────────────────────────

    def _reset_state(self):
        self.stroke_pts   = []
        self.stroke_t     = []
        self.closed_pts   = []
        self.contour_area = 0
        self.drawing      = False
        self.processing   = False
        self.closed       = False
        self.floating     = False
        self.start_t      = None
        self.end_t        = None
        self.release_x    = self.release_y    = 0
        self.float_anchor_x = self.float_anchor_y = 0
        self.float_final_x  = self.float_final_y  = None
        self.float_img      = None
        self.float_tk       = None
        self._reset_overlay()
        self.canvas.delete("float")
        self.canvas.delete("status")
        self.canvas.delete("prompt")
        self.canvas.config(cursor="crosshair")

    # ── save ──────────────────────────────────────────────────────────────

    def _finish(self):
        if self.closed_pts:
            self._save()
        self.root.destroy()

    def _save(self):
        OUTPUT_DIR.mkdir(exist_ok=True)
        ts  = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = OUTPUT_DIR / f"qsel_{ts}.json"

        duration = (
            int((self.end_t - self.start_t) * 1000)
            if self.start_t and self.end_t else 0
        )

        data = {
            "recorded_at":      datetime.now().isoformat(),
            "prompt":           self.prompt_text,
            "source":           self.source,
            "image_size":       [self.img_w, self.img_h],
            "brush_radius":     BRUSH_RADIUS,
            "duration_ms":      duration,
            "stroke":           [{"x": x, "y": y, "t": t}
                                  for (x, y), t in zip(self.stroke_pts, self.stroke_t)],
            "contour":          [{"x": x, "y": y} for x, y in self.closed_pts],
            "contour_area_px":  self.contour_area,
            "float_dropped_at": (
                [self.float_final_x, self.float_final_y]
                if self.float_final_x is not None else None
            ),
        }
        out.write_text(json.dumps(data, indent=2))
        print(f"\n  saved → {out.resolve()}")
        print(f"  stroke: {len(self.stroke_pts)} pts  /  "
              f"contour: {len(self.closed_pts)} pts  /  "
              f"dropped at: {data['float_dropped_at']}")

    def run(self):
        self.root.mainloop()


# ── entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Paint a selection on a GAN face. Let the algorithm decide."
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

    QuickSelector(img, source).run()


if __name__ == "__main__":
    main()