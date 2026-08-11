"""Browse a folder of captures as a UMAP of their CLIP embeddings.

    python -m pilot.umap_view documents/sequences/run/captures

Hover a point to see the capture. Click one to load its config into a running
Fluoddity, if there is one. Drag to pan, scroll to zoom, and recompute the
projection with different UMAP settings without re-embedding anything.

SEPARATE FROM BOTH THE APP AND THE SEARCH, on purpose. It opens its own window
and runs its own loop, so it can be used while a search is running -- and it
keeps umap, sklearn and numba out of the app's import path, which currently
pulls in no ML stack at all.

Nothing here computes: gallery.py embeds and caches, projection.py lays out.
This file draws.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


import numpy as np

from . import gallery as gallery_lib
from . import projection as projection_lib
from .config import SearchConfig

#: Tooltip preview size. Small enough to upload thousands of, big enough to
#: judge a pattern by.
THUMB = 160

#: Hit radius in screen pixels. Generous: points overlap heavily in a dense
#: cluster and a tight radius makes hovering feel broken.
HIT_RADIUS = 7.0

#: Zoom limits. Past ~40x a cluster is a handful of points and panning is
#: awkward; below 1 there is nothing to see outside the layout.
MIN_ZOOM, MAX_ZOOM = 0.5, 40.0


class TextureStore:
    """GL textures for the previews, uploaded on demand.

    LAZY, because a run folder holds thousands of captures and uploading them
    all at open would cost seconds and hundreds of megabytes of VRAM for
    images most of which will never be hovered. Only what is actually looked
    at is uploaded, and it is kept afterwards -- re-hovering is instant, and a
    session realistically touches a few hundred at most.
    """

    def __init__(self, size=THUMB):
        self.size = size
        self._ids = {}

    def get(self, path):
        """The texture for `path`, uploading it on first use. None on failure."""
        key = str(path)
        if key in self._ids:
            return self._ids[key]

        import OpenGL.GL as gl
        from PIL import Image

        try:
            image = Image.open(path).convert('RGBA').resize(
                (self.size, self.size), Image.LANCZOS)
        except (OSError, ValueError):
            # A capture that failed to write, or is not an image. Cache the
            # failure so a broken file is not retried every frame.
            self._ids[key] = None
            return None

        data = np.asarray(image, dtype=np.uint8)
        texture = gl.glGenTextures(1)
        gl.glBindTexture(gl.GL_TEXTURE_2D, texture)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MIN_FILTER,
                           gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_MAG_FILTER,
                           gl.GL_LINEAR)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_S,
                           gl.GL_CLAMP_TO_EDGE)
        gl.glTexParameteri(gl.GL_TEXTURE_2D, gl.GL_TEXTURE_WRAP_T,
                           gl.GL_CLAMP_TO_EDGE)
        gl.glTexImage2D(gl.GL_TEXTURE_2D, 0, gl.GL_RGBA,
                        image.width, image.height, 0,
                        gl.GL_RGBA, gl.GL_UNSIGNED_BYTE, data)
        self._ids[key] = int(texture)
        return self._ids[key]

    def __len__(self):
        return sum(1 for v in self._ids.values() if v is not None)


def score_colour(value, low, high):
    """Blue (worst) -> grey -> orange (best), as a packed imgui colour.

    Diverging rather than a single ramp because what matters when scanning a
    layout is which end a point is at, and a light-to-dark ramp makes the
    middle and one extreme look alike against a dark background.
    """
    from imgui_bundle import imgui

    if not np.isfinite(value) or high <= low:
        return imgui.color_convert_float4_to_u32(
            imgui.ImVec4(0.75, 0.75, 0.75, 1.0))
    t = (value - low) / (high - low)
    t = float(np.clip(t, 0.0, 1.0))
    if t < 0.5:
        u = t * 2.0
        r, g, b = 0.25 + 0.45 * u, 0.45 + 0.30 * u, 0.95 - 0.20 * u
    else:
        u = (t - 0.5) * 2.0
        r, g, b = 0.70 + 0.30 * u, 0.75 - 0.30 * u, 0.75 - 0.65 * u
    return imgui.color_convert_float4_to_u32(imgui.ImVec4(r, g, b, 1.0))


class Viewer:
    """The window: state, drawing, and the interactions."""

    def __init__(self, gallery, projection, client=None):
        self.gallery = gallery
        self.projection = projection
        self.client = client
        self.textures = TextureStore()

        self.pan = [0.0, 0.0]
        self.zoom = 1.0
        self.point_size = 4.0
        self.colour_by_score = gallery.has_scores
        self.status = ''

        # Slider state, separate from what the CURRENT projection used -- the
        # gap between them is what makes "the plot is stale" visible.
        self.n_neighbours = projection.n_neighbours
        self.min_dist = projection.min_dist
        self.seed = projection.seed

        scores = gallery.scores
        finite = scores[np.isfinite(scores)]
        self.score_low = float(finite.min()) if len(finite) else 0.0
        self.score_high = float(finite.max()) if len(finite) else 1.0

    # ------------------------------------------------------------------

    @property
    def stale(self):
        """True when the sliders no longer describe the plot on screen."""
        return (self.n_neighbours != self.projection.n_neighbours
                or abs(self.min_dist - self.projection.min_dist) > 1e-9
                or self.seed != self.projection.seed)

    def recompute(self):
        self.status = "projecting..."
        self.projection = projection_lib.project(
            self.gallery.embeddings, n_neighbours=self.n_neighbours,
            min_dist=self.min_dist, seed=self.seed)
        # Clamped inside project(), so read back what was actually used.
        self.n_neighbours = self.projection.n_neighbours
        self.status = f"projected {len(self.gallery)} points"

    def to_screen(self, point, origin, size):
        """Normalized layout coords -> screen pixels, through pan and zoom."""
        x = (point[0] - 0.5) * self.zoom + 0.5 + self.pan[0]
        # Y is flipped: UMAP's +y is up, the screen's is down.
        y = (0.5 - (point[1] - 0.5) * self.zoom) - self.pan[1]
        return origin.x + x * size.x, origin.y + y * size.y

    # ------------------------------------------------------------------

    def draw(self):
        """Render into hello_imgui's full-screen window. Opens none of its own."""
        self._controls()
        from imgui_bundle import imgui

        imgui.separator()
        self._canvas()

    def _controls(self):
        from imgui_bundle import imgui

        imgui.text(f"{len(self.gallery)} images   {self.gallery.signature}")
        imgui.text_disabled(str(self.gallery.root))

        changed_n, self.n_neighbours = imgui.slider_int(
            "n_neighbors", self.n_neighbours, 2,
            max(3, min(200, len(self.gallery) - 1)))
        changed_d, self.min_dist = imgui.slider_float(
            "min_dist", self.min_dist, 0.0, 0.99)
        changed_s, self.seed = imgui.slider_int("seed", self.seed, 0, 999)

        # A button rather than recomputing on release: UMAP on a few thousand
        # points takes seconds, and brushing a slider should not freeze the
        # window. This also lets both sliders move before paying once.
        if imgui.button("Recompute" + (" *" if self.stale else "")):
            self.recompute()
        imgui.same_line()
        if imgui.button("Reset view"):
            self.pan, self.zoom = [0.0, 0.0], 1.0

        imgui.same_line()
        _, self.point_size = imgui.slider_float("size", self.point_size,
                                                1.5, 12.0)

        if self.gallery.has_scores:
            imgui.same_line()
            _, self.colour_by_score = imgui.checkbox("colour by score",
                                                     self.colour_by_score)

        if self.stale:
            imgui.text_disabled(
                f"showing {self.projection.describe()} -- press Recompute")
        elif self.status:
            imgui.text_disabled(self.status)

    def _canvas(self):
        from imgui_bundle import imgui

        origin = imgui.get_cursor_screen_pos()
        available = imgui.get_content_region_avail()
        size = imgui.ImVec2(max(64.0, available.x), max(64.0, available.y - 4))
        draw = imgui.get_window_draw_list()

        draw.add_rect_filled(
            origin, imgui.ImVec2(origin.x + size.x, origin.y + size.y),
            imgui.get_color_u32(imgui.Col_.frame_bg.value))

        # An invisible button over the canvas claims the mouse, so dragging
        # pans the plot instead of the window and scrolling zooms instead of
        # scrolling the panel.
        imgui.invisible_button("##canvas", size)
        active = imgui.is_item_active()
        hovered_canvas = imgui.is_item_hovered()

        io = imgui.get_io()
        if active and imgui.is_mouse_dragging(0):
            delta = imgui.get_mouse_drag_delta(0)
            self.pan[0] += delta.x / size.x
            self.pan[1] += delta.y / size.y
            imgui.reset_mouse_drag_delta(0)

        mouse = imgui.get_mouse_pos()
        if hovered_canvas and io.mouse_wheel:
            # Anchored on the cursor: the point under the mouse stays put, so
            # zooming into a cluster does not require chasing it with pans.
            before = self._from_screen(mouse, origin, size)
            self.zoom = float(np.clip(self.zoom * (1.1 ** io.mouse_wheel),
                                      MIN_ZOOM, MAX_ZOOM))
            after = self._from_screen(mouse, origin, size)
            self.pan[0] += (after[0] - before[0]) * self.zoom
            self.pan[1] -= (after[1] - before[1]) * self.zoom

        draw.push_clip_rect(origin,
                            imgui.ImVec2(origin.x + size.x, origin.y + size.y),
                            True)
        hovered = self._draw_points(draw, origin, size, mouse, hovered_canvas)
        draw.pop_clip_rect()

        if hovered >= 0:
            self._tooltip(hovered)
            if imgui.is_mouse_clicked(0):
                self._activate(self.gallery.items[hovered])

    def _from_screen(self, pixel, origin, size):
        """Screen pixels -> normalized layout coords. Inverse of to_screen."""
        x = (pixel.x - origin.x) / size.x
        y = (pixel.y - origin.y) / size.y
        return ((x - self.pan[0] - 0.5) / self.zoom + 0.5,
                0.5 - ((y + self.pan[1]) - 0.5) / self.zoom)

    def _draw_points(self, draw, origin, size, mouse, can_hover):
        from imgui_bundle import imgui

        points = self.projection.points
        scores = self.gallery.scores
        plain = imgui.color_convert_float4_to_u32(
            imgui.ImVec4(0.85, 0.85, 0.88, 1.0))

        hovered = -1
        best = HIT_RADIUS * HIT_RADIUS
        for i in range(len(points)):
            px, py = self.to_screen(points[i], origin, size)
            # Cheap reject: a dense layout puts most points off-screen when
            # zoomed in, and add_circle_filled is not free at 4,000 a frame.
            if not (origin.x - 8 <= px <= origin.x + size.x + 8
                    and origin.y - 8 <= py <= origin.y + size.y + 8):
                continue

            colour = (score_colour(scores[i], self.score_low, self.score_high)
                      if self.colour_by_score else plain)
            draw.add_circle_filled(imgui.ImVec2(px, py), self.point_size,
                                   colour)

            if can_hover:
                dx, dy = mouse.x - px, mouse.y - py
                distance = dx * dx + dy * dy
                if distance < best:
                    best, hovered = distance, i

        if hovered >= 0:
            px, py = self.to_screen(points[hovered], origin, size)
            draw.add_circle(imgui.ImVec2(px, py), self.point_size + 3.0,
                            imgui.color_convert_float4_to_u32(
                                imgui.ImVec4(1.0, 1.0, 1.0, 0.9)), 0, 2.0)
        return hovered

    def _tooltip(self, index):
        from imgui_bundle import imgui

        item = self.gallery.items[index]
        imgui.begin_tooltip()
        for line in item.tooltip_lines():
            imgui.text(line)
        texture = self.textures.get(item.path)
        if texture:
            imgui.image(imgui.ImTextureRef(texture),
                        imgui.ImVec2(THUMB, THUMB))
        else:
            imgui.text_disabled("(preview unavailable)")
        if item.config_path:
            imgui.text_disabled("click to load into Fluoddity")
        imgui.end_tooltip()

    def _activate(self, item):
        """Click: load the config into a running app, or copy its path.

        The viewer must work with no app running -- it is a browser for
        finished runs, and requiring a live simulation to look at one would be
        backwards. So a missing app is a status line, not an error.
        """
        from imgui_bundle import imgui

        target = item.config_path or ''
        if not target:
            imgui.set_clipboard_text(str(item.path))
            self.status = f"no config recorded; copied {item.path.name}"
            return

        if self.client is not None:
            try:
                self.client.load_config(target)
                self.status = f"loaded {Path(target).name} into Fluoddity"
                return
            except Exception as e:                          # noqa: BLE001
                self.status = f"could not load ({type(e).__name__}); copied path"

        imgui.set_clipboard_text(str(target))
        if self.client is None:
            self.status = f"no app connected; copied {Path(target).name}"


def connect(port):
    """A client for a running app, or None. Never raises."""
    from .client import FluoddityClient

    client = FluoddityClient(port=port)
    try:
        client.health()
        print(f"  connected to Fluoddity on port {port}")
        return client
    except Exception:                                       # noqa: BLE001
        print(f"  no Fluoddity on port {port}; click-to-load will copy paths")
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Browse a folder of captures as a UMAP of CLIP embeddings")
    parser.add_argument('folder', help="folder of images (e.g. a run's captures/)")
    parser.add_argument('--config', help="search config for the embedding "
                                         "settings (backend, crops, grayscale)")
    parser.add_argument('--port', type=int, default=8765,
                        help="Fluoddity API port for click-to-load")
    parser.add_argument('--neighbours', type=int,
                        default=projection_lib.DEFAULT_NEIGHBOURS)
    parser.add_argument('--min-dist', type=float,
                        default=projection_lib.DEFAULT_MIN_DIST)
    parser.add_argument('--seed', type=int, default=projection_lib.DEFAULT_SEED)
    parser.add_argument('--refresh', action='store_true',
                        help="re-embed even if a cache is present")
    parser.add_argument('--no-recursive', action='store_true')
    args = parser.parse_args(argv)

    problems = projection_lib.check_dependencies()
    if problems:
        for problem in problems:
            print(problem)
        return 1

    cfg = SearchConfig.load(args.config) if args.config else SearchConfig(
        backend='clip', crops=6, crop_frac=0.5, grayscale=True)
    from . import embedding
    problems = embedding.check_dependencies(cfg.backend)
    if problems:
        for problem in problems:
            print(problem)
        return 1

    folder = Path(args.folder)
    print(f"opening {folder}")
    gallery = gallery_lib.build(folder, cfg, recursive=not args.no_recursive,
                                refresh=args.refresh)

    print(f"  projecting {len(gallery)} points")
    projection = projection_lib.project(
        gallery.embeddings, n_neighbours=args.neighbours,
        min_dist=args.min_dist, seed=args.seed)

    viewer = Viewer(gallery, projection, client=connect(args.port))

    from imgui_bundle import immapp

    params = immapp.RunnerParams()
    params.app_window_params.window_title = f"UMAP -- {folder.name}"
    params.app_window_params.window_geometry.size = (1100, 820)
    # The default full-screen window IS what is wanted here: the plot should
    # fill the frame rather than float inside it, so draw() renders straight
    # into it instead of opening one of its own.
    params.callbacks.show_gui = viewer.draw
    # Idle when nothing moves: this sits open beside a search, and a viewer
    # spinning a GPU at full rate would compete with the thing it is watching.
    params.fps_idling.enable_idling = True
    params.fps_idling.fps_idle = 10.0
    immapp.run(params)
    return 0


if __name__ == '__main__':
    sys.exit(main())
