"""The pilot GUI: browse captures, try captions, run searches.

    python -m pilot.umap_view                       # open empty, load from the GUI
    python -m pilot.umap_view <folder>              # open a folder straight away

Started as a UMAP browser and became the front end for everything the pilot
does: loading a folder, colouring it by a caption, filtering to the best or
worst of it, running a report or a re-score, and launching a search.

OPENS EMPTY AND PROJECTS ON DEMAND. A UMAP of a few thousand points costs
twenty-five seconds, and half of what this tool is now for -- trying captions,
reading scores, launching a search -- does not need one at all. So the map is
something you ask for, not something you wait through.

SEPARATE FROM BOTH THE APP AND THE SEARCH. Its own window, its own process, so
it can sit open while a search runs -- and umap, sklearn and numba stay out of
the app's import path, which pulls in no ML stack at all.

THE SLOW WORK IS ON A THREAD (see task.py). Loading, projecting and searching
all take longer than a frame, and a frozen window cannot show a running search.
Only immutable snapshots cross back to the drawing side.

Nothing here computes: gallery.py embeds and caches, projection.py lays out,
scoring.py scores. This file draws and wires.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from . import gallery as gallery_lib
from . import projection as projection_lib
from .config import SearchConfig
from .task import Task

#: Tooltip preview size. Small enough to upload thousands of, big enough to
#: judge a pattern by.
THUMB = 160

#: Hit radius in screen pixels. Generous: points overlap heavily in a dense
#: cluster and a tight radius makes hovering feel broken.
HIT_RADIUS = 7.0

#: Zoom limits. Past ~40x a cluster is a handful of points and panning is
#: awkward; below 1 there is nothing to see outside the layout.
MIN_ZOOM, MAX_ZOOM = 0.5, 40.0

#: How points are coloured.
COLOUR_PLAIN = 0
COLOUR_SCORE = 1
COLOUR_CAPTION = 2


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

    def forget(self):
        """Drop the mapping when the folder changes.

        The GL names leak rather than being deleted: freeing them needs the GL
        context, this may be called from anywhere, and a session changes folder
        a handful of times at a few hundred small textures each.
        """
        self._ids = {}

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
    t = float(np.clip((value - low) / (high - low), 0.0, 1.0))
    if t < 0.5:
        u = t * 2.0
        r, g, b = 0.25 + 0.45 * u, 0.45 + 0.30 * u, 0.95 - 0.20 * u
    else:
        u = (t - 0.5) * 2.0
        r, g, b = 0.70 + 0.30 * u, 0.75 - 0.30 * u, 0.75 - 0.65 * u
    return imgui.color_convert_float4_to_u32(imgui.ImVec4(r, g, b, 1.0))


class Viewer:
    """The window: state, drawing, and the interactions."""

    def __init__(self, cfg=None, client=None, port=8765):
        self.cfg = cfg or SearchConfig()
        self.client = client
        self.port = port
        self.textures = TextureStore()

        #: Loaded on demand; None means nothing is open yet.
        self.gallery = None
        self.projection = None
        self.backend = None
        self.folder = ''
        self.config_path = ''

        #: The one piece of background work in flight, if any.
        self.task = None
        self.task_kind = ''

        self.pan = [0.0, 0.0]
        self.zoom = 1.0
        self.point_size = 4.0
        self.colour_mode = COLOUR_PLAIN
        self.status = 'no folder loaded'

        self.caption = ''
        self.caption_applied = ''
        self.caption_scores = None
        self.caption_calibrate = True

        #: Percentile of the dataset to HIDE. A lens on the plot only: the
        #: layout and the percentile maths always use the full set, so moving
        #: this never reshuffles what survives.
        self.cutoff = 0.0
        self.cutoff_bottom = False

        self.n_neighbours = projection_lib.DEFAULT_NEIGHBOURS
        self.min_dist = projection_lib.DEFAULT_MIN_DIST
        self.seed = projection_lib.DEFAULT_SEED

    # ------------------------------------------------------------------
    # Background work
    # ------------------------------------------------------------------

    @property
    def busy(self):
        return self.task is not None and self.task.running

    def _begin(self, kind, label, work):
        """Start background work, refusing to start a second at once."""
        if self.busy:
            self.status = f"already {self.task_kind}; wait for it to finish"
            return False
        self.task_kind = kind
        self.task = Task.start(label, work)
        return True

    def _collect(self):
        """Fold a finished task's result back in. Called once per frame."""
        if self.task is None or self.task.running:
            return
        progress = self.task.progress
        kind, self.task, self.task_kind = self.task_kind, None, ''

        if progress.failed:
            self.status = progress.error
            return

        if kind == 'loading':
            self.gallery, self.backend = progress.result
            self.projection = None
            self.caption_scores = None
            self.caption_applied = ''
            self.textures.forget()
            self.colour_mode = (COLOUR_SCORE if self.gallery.has_scores
                                else COLOUR_PLAIN)
            self.status = (f"loaded {len(self.gallery)} images -- "
                           f"press Compute UMAP to project")
        elif kind == 'projecting':
            self.projection = progress.result
            self.n_neighbours = self.projection.n_neighbours
            self.pan, self.zoom = [0.0, 0.0], 1.0
            self.status = f"projected {len(self.gallery)} points"
        elif kind == 'searching':
            self.status = progress.result or "search finished"
        else:
            self.status = progress.latest or f"{kind} finished"

    # ------------------------------------------------------------------

    def load_folder(self, folder, config_path=None):
        """Embed a folder on a background thread."""
        folder = Path(folder).expanduser()
        if not folder.is_dir():
            self.status = f"not a folder: {folder}"
            return
        if config_path:
            try:
                self.cfg = SearchConfig.load(config_path)
                self.config_path = str(config_path)
            except Exception as e:                              # noqa: BLE001
                self.status = f"could not read config: {e}"
                return

        cfg = self.cfg
        self.folder = str(folder)

        def work(report):
            from . import embedding

            gallery = gallery_lib.build(folder, cfg, progress=report)
            return gallery, embedding.build_backend(cfg)

        if self._begin('loading', f"loading {folder.name}", work):
            self.status = f"loading {folder}..."

    def compute_projection(self):
        if self.gallery is None:
            self.status = "load a folder first"
            return
        embeddings = self.gallery.embeddings
        n, d, s = self.n_neighbours, self.min_dist, self.seed

        def work(report):
            report(f"projecting {len(embeddings)} points")
            return projection_lib.project(embeddings, n_neighbours=n,
                                          min_dist=d, seed=s)

        if self._begin('projecting', "projecting", work):
            self.status = "projecting..."

    @property
    def stale(self):
        """True when the sliders no longer describe the plot on screen."""
        if self.projection is None:
            return False
        return (self.n_neighbours != self.projection.n_neighbours
                or abs(self.min_dist - self.projection.min_dist) > 1e-9
                or self.seed != self.projection.seed)

    def apply_caption(self):
        """Colour the map by similarity to the typed caption.

        Cheap by design: the image embeddings are already in memory, so this
        is one text encode plus a matrix multiply -- measured at ~40ms across
        4,292 images. Trying twenty phrasings costs seconds, which is what
        makes this the right place to choose the negatives for a search.
        """
        caption = self.caption.strip()
        if self.gallery is None:
            self.status = "load a folder first"
            return
        if not caption:
            self.status = "type a caption first"
            return
        if self.backend is None or not getattr(self.backend, 'supports_text',
                                               False):
            self.status = "caption colouring needs the clip backend"
            return

        try:
            self.caption_scores = gallery_lib.score_caption(
                self.gallery, caption, self.backend,
                calibrate=self.caption_calibrate,
                aggregate=self.cfg.aggregate)
        except Exception as e:                                  # noqa: BLE001
            self.status = f"{type(e).__name__}: {e}"
            return

        self.caption_applied = caption
        self.colour_mode = COLOUR_CAPTION
        finite = self.caption_scores[np.isfinite(self.caption_scores)]
        if len(finite):
            self.status = (f'"{caption}"  range {finite.min():+.2f} .. '
                           f'{finite.max():+.2f}')

    def active_scores(self):
        """(values, low, high) for the current colour mode, or None."""
        if self.colour_mode == COLOUR_CAPTION \
                and self.caption_scores is not None:
            values = self.caption_scores
        elif (self.colour_mode == COLOUR_SCORE and self.gallery is not None
                and self.gallery.has_scores):
            values = self.gallery.scores
        else:
            return None
        finite = values[np.isfinite(values)]
        if not len(finite):
            return None
        return values, float(finite.min()), float(finite.max())

    def visible_mask(self):
        """Which points the cutoff leaves on screen. None means all of them."""
        shading = self.active_scores()
        if shading is None or self.cutoff <= 0:
            return None
        return gallery_lib.percentile_mask(shading[0], self.cutoff,
                                           bottom=self.cutoff_bottom)

    # ------------------------------------------------------------------
    # Geometry
    # ------------------------------------------------------------------

    def to_screen(self, point, origin, size):
        """Normalized layout coords -> screen pixels, through pan and zoom.

        PAN IS IN SCREEN SPACE, and both components are added. The y flip
        below (UMAP's +y is up, the screen's is down) applies to the POINT
        only; applying it to the pan as well would invert it a second time and
        make dragging down move the plot up.
        """
        x = (point[0] - 0.5) * self.zoom + 0.5 + self.pan[0]
        y = (0.5 - (point[1] - 0.5) * self.zoom) + self.pan[1]
        return origin.x + x * size.x, origin.y + y * size.y

    def _from_screen(self, pixel, origin, size):
        """Screen pixels -> normalized layout coords. EXACT inverse of
        to_screen -- if the two disagree, cursor-anchored zoom drifts."""
        x = (pixel.x - origin.x) / size.x
        y = (pixel.y - origin.y) / size.y
        return ((x - self.pan[0] - 0.5) / self.zoom + 0.5,
                0.5 - ((y - self.pan[1]) - 0.5) / self.zoom)

    # ------------------------------------------------------------------
    # Drawing
    # ------------------------------------------------------------------

    def draw(self):
        """Render into hello_imgui's full-screen window."""
        from imgui_bundle import imgui

        self._collect()

        self._source_panel()
        imgui.separator()
        self._caption_panel()
        imgui.separator()
        self._actions_panel()
        imgui.separator()
        self._map_panel()
        imgui.separator()
        self._status_bar()
        self._canvas()

    # ---- panels ----

    def _source_panel(self):
        from imgui_bundle import imgui

        imgui.set_next_item_width(520)
        _, self.folder = imgui.input_text("folder", self.folder)
        imgui.same_line()
        if imgui.button("Load##folder"):
            self.load_folder(self.folder, self.config_path or None)
        _tip("Embed every image in this folder. Uses the shared cache, so a "
             "folder a search has already scored opens instantly.")

        imgui.set_next_item_width(520)
        _, self.config_path = imgui.input_text("config", self.config_path)
        imgui.same_line()
        if imgui.button("Reload##config"):
            if self.config_path:
                try:
                    self.cfg = SearchConfig.load(self.config_path)
                    self.status = f"config: {self.cfg.describe_plan()}"
                except Exception as e:                          # noqa: BLE001
                    self.status = f"could not read config: {e}"
        _tip("A search config JSON. Supplies the embedding settings (backend, "
             "crops, grayscale) and is what a search launched here will run.")

        if self.gallery is not None:
            scored = 'scored' if self.gallery.has_scores else 'no scores'
            imgui.text_disabled(
                f"{len(self.gallery)} images, {scored}   "
                f"{self.gallery.signature}")

    def _caption_panel(self):
        """Colour by a caption. The reason this tool earns its keep.

        Seeing WHICH cluster a caption lights up answers two questions a
        report cannot: whether the words mean what you think against these
        images, and what to put in negative_captions -- name the thing the
        search keeps rediscovering and you can subtract it.
        """
        from imgui_bundle import imgui

        imgui.set_next_item_width(380)
        entered, self.caption = imgui.input_text(
            "caption", self.caption,
            imgui.InputTextFlags_.enter_returns_true.value)
        if entered:
            self.apply_caption()
        _tip("Colour the points by similarity to this phrase. Enter applies "
             "it. Costs one text encode -- try a dozen.")

        imgui.same_line()
        pending = self.caption.strip() != self.caption_applied
        if imgui.button("Recompute colour from caption"
                        + (" *" if pending and self.caption.strip() else "")):
            self.apply_caption()

        imgui.same_line()
        _, self.caption_calibrate = imgui.checkbox("calibrate",
                                                   self.caption_calibrate)
        _tip("Score against 30 generic background captions and report a robust "
             "per-image z, exactly as a caption search does.\n"
             "Off shows the raw cosine, which spans about two percent and "
             "mostly describes the caption rather than the image.")

        self._colour_modes()
        self._cutoff()

    def _colour_modes(self):
        from imgui_bundle import imgui

        modes = [("plain", COLOUR_PLAIN)]
        if self.gallery is not None and self.gallery.has_scores:
            modes.append(("run score", COLOUR_SCORE))
        if self.caption_scores is not None:
            modes.append((f'"{self.caption_applied[:28]}"', COLOUR_CAPTION))
        if len(modes) < 2:
            return
        imgui.text("colour by")
        for label, mode in modes:
            imgui.same_line()
            if imgui.radio_button(label, self.colour_mode == mode):
                self.colour_mode = mode

    def _cutoff(self):
        """Hide all but the top (or bottom) slice by score."""
        from imgui_bundle import imgui

        shading = self.active_scores()
        enabled = shading is not None
        if not enabled:
            imgui.begin_disabled()

        imgui.set_next_item_width(300)
        _, self.cutoff = imgui.slider_float("percentile cutoff", self.cutoff,
                                            0.0, 99.0, "%.0f%%")
        if not enabled:
            imgui.end_disabled()
        _tip("Hide points outside the top slice of the CURRENT colour -- run "
             "score or caption. 0 shows everything; 90 keeps the best tenth.\n"
             "Needs something scored: pick a colour mode or apply a caption."
             if not enabled else
             "Hide all but the best slice of the current colour. A lens only "
             "-- the layout never moves when you drag this.")

        imgui.same_line()
        if not enabled:
            imgui.begin_disabled()
        _, self.cutoff_bottom = imgui.checkbox("bottom percentile",
                                               self.cutoff_bottom)
        if not enabled:
            imgui.end_disabled()
        _tip("Keep the WORST slice instead of the best. Isolating failures is "
             "how you find a negative caption worth subtracting.")

        if enabled and self.cutoff > 0:
            mask = self.visible_mask()
            shown = int(mask.sum()) if mask is not None else len(self.gallery)
            end = "bottom" if self.cutoff_bottom else "top"
            imgui.same_line()
            imgui.text_disabled(f"{shown} shown ({end})")

    def _actions_panel(self):
        from imgui_bundle import imgui

        if self.busy:
            imgui.begin_disabled()

        if imgui.button("Write report"):
            self._write_report()
        _tip("Rank the run's manifest and write report.txt -- top 32 and "
             "bottom 32 with scores, lineage and capture paths.")

        imgui.same_line()
        if imgui.button("Re-score run"):
            self._rescore()
        _tip("Re-score every capture against the config's CURRENT objective "
             "and rewrite report.txt. Re-embeds nothing; only the text side "
             "is new.")

        imgui.same_line()
        if imgui.button("Run search"):
            self._run_search()
        _tip("Launch a search with the loaded config. Runs on a background "
             "thread; Fluoddity must be running with --api-port.")

        if self.busy:
            imgui.end_disabled()
            imgui.same_line()
            progress = self.task.progress
            imgui.text(f"{self.task_kind}: {progress.latest}")

    def _map_panel(self):
        from imgui_bundle import imgui

        count = len(self.gallery) if self.gallery is not None else 3
        imgui.set_next_item_width(200)
        _, self.n_neighbours = imgui.slider_int(
            "n_neighbors", self.n_neighbours, 2, max(3, min(200, count - 1)))
        _tip("UMAP's locality. Low values emphasise fine structure, high "
             "values the overall shape.")
        imgui.same_line()
        imgui.set_next_item_width(180)
        _, self.min_dist = imgui.slider_float("min_dist", self.min_dist,
                                              0.0, 0.99)
        _tip("How tightly points may pack. Low values make dense clumps.")
        imgui.same_line()
        imgui.set_next_item_width(140)
        _, self.seed = imgui.slider_int("seed", self.seed, 0, 999)

        label = ("Compute UMAP" if self.projection is None
                 else "Recompute UMAP" + (" *" if self.stale else ""))
        if self.busy:
            imgui.begin_disabled()
        if imgui.button(label):
            self.compute_projection()
        if self.busy:
            imgui.end_disabled()
        _tip("Project the embeddings to 2D. Takes ~25s for a few thousand "
             "points, which is why it is a button and not automatic.")

        imgui.same_line()
        if imgui.button("Reset view"):
            self.pan, self.zoom = [0.0, 0.0], 1.0
        imgui.same_line()
        imgui.set_next_item_width(140)
        _, self.point_size = imgui.slider_float("size", self.point_size,
                                                1.5, 12.0)

    def _status_bar(self):
        from imgui_bundle import imgui

        if self.stale:
            imgui.text_disabled(
                f"showing {self.projection.describe()} -- press Recompute")
        elif self.status:
            imgui.text_disabled(self.status)

    # ---- the plot ----

    def _canvas(self):
        from imgui_bundle import imgui

        origin = imgui.get_cursor_screen_pos()
        available = imgui.get_content_region_avail()
        size = imgui.ImVec2(max(64.0, available.x), max(64.0, available.y - 4))
        draw = imgui.get_window_draw_list()

        draw.add_rect_filled(
            origin, imgui.ImVec2(origin.x + size.x, origin.y + size.y),
            imgui.get_color_u32(imgui.Col_.frame_bg.value))

        if self.projection is None:
            message = ("load a folder, then press Compute UMAP"
                       if self.gallery is None
                       else "press Compute UMAP to project")
            draw.add_text(imgui.ImVec2(origin.x + 16, origin.y + 16),
                          imgui.get_color_u32(imgui.Col_.text_disabled.value),
                          message)
            return

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
            before = self._from_screen(mouse, origin, size)
            self.zoom = float(np.clip(self.zoom * (1.1 ** io.mouse_wheel),
                                      MIN_ZOOM, MAX_ZOOM))
            after = self._from_screen(mouse, origin, size)
            # Shift the pan so the layout point that was under the cursor is
            # under it again. Both terms scale by the NEW zoom; the y term is
            # negated because pan is screen-space (down-positive) while the
            # layout coords these deltas are in are up-positive.
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

    def _draw_points(self, draw, origin, size, mouse, can_hover):
        from imgui_bundle import imgui

        points = self.projection.points
        plain = imgui.color_convert_float4_to_u32(
            imgui.ImVec4(0.85, 0.85, 0.88, 1.0))
        shading = self.active_scores()
        mask = self.visible_mask()

        hovered = -1
        best = HIT_RADIUS * HIT_RADIUS
        for i in range(len(points)):
            if mask is not None and not mask[i]:
                continue
            px, py = self.to_screen(points[i], origin, size)
            # Cheap reject: a dense layout puts most points off-screen when
            # zoomed in, and add_circle_filled is not free at 4,000 a frame.
            if not (origin.x - 8 <= px <= origin.x + size.x + 8
                    and origin.y - 8 <= py <= origin.y + size.y + 8):
                continue

            colour = (score_colour(shading[0][i], shading[1], shading[2])
                      if shading is not None else plain)
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
        # The caption score belongs here as much as on the colour ramp: the
        # ramp shows where a caption fires, the number says how strongly.
        if self.caption_scores is not None:
            imgui.text_disabled(
                f'"{self.caption_applied}"  {self.caption_scores[index]:+.3f}')
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
            except Exception as e:                              # noqa: BLE001
                self.status = f"could not load ({type(e).__name__}); copied path"

        imgui.set_clipboard_text(str(target))
        if self.client is None:
            self.status = f"no app connected; copied {Path(target).name}"

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _run_dir(self):
        """The run folder for the loaded captures, if this looks like one."""
        if not self.folder:
            return None
        folder = Path(self.folder)
        for candidate in (folder, folder.parent):
            if (candidate / 'manifest.jsonl').is_file():
                return candidate
        return None

    def _write_report(self):
        from . import run as run_lib

        root = self._run_dir()
        if root is None:
            self.status = "no manifest.jsonl -- this is not a run folder"
            return
        cfg = self.cfg

        def work(report):
            report("ranking manifest")
            path = run_lib.write_report(run_lib.RunFolder(root), cfg)
            return f"wrote {path}"

        if self._begin('report', "report", work):
            self.status = "writing report..."

    def _rescore(self):
        from . import run as run_lib

        root = self._run_dir()
        if root is None:
            self.status = "no manifest.jsonl -- this is not a run folder"
            return
        cfg = self.cfg

        def work(report):
            from . import report as report_lib

            folder = run_lib.RunFolder(root)
            # Deduped for the same reason the report dedupes: in folders
            # written before ids carried a session tag, only the last row for
            # an id describes the capture actually on disk.
            kept, _ = report_lib.dedupe(folder.read())
            report(f"re-scoring {len(kept)} captures")
            rescored = run_lib._rescore(kept, cfg, folder)
            path = report_lib.write(
                folder.report, rescored, cfg=cfg, root=folder.root,
                title=f"Fluoddity search results -- {folder.root.name}")
            return f"re-scored {len(rescored)}; wrote {path}"

        if self._begin('rescore', "rescore", work):
            self.status = "re-scoring..."

    def _run_search(self):
        from . import run as run_lib

        cfg = self.cfg
        if not self.config_path:
            self.status = "load a search config first"
            return

        def work(report):
            report(cfg.describe_plan())
            search = run_lib.SearchRun(cfg)
            search.run()
            best = search.strategy.best
            return (f"search done: {len(search.strategy.archive)} candidates"
                    + (f", best {best.score:+.4f}" if best else ""))

        if self._begin('searching', "search", work):
            self.status = f"search: {cfg.describe_plan()}"


def _tip(text):
    """Attach a tooltip to the widget just drawn."""
    from imgui_bundle import imgui

    if imgui.is_item_hovered():
        imgui.set_tooltip(text)


def connect(port):
    """A client for a running app, or None. Never raises."""
    from .client import FluoddityClient

    client = FluoddityClient(port=port)
    try:
        client.health()
        print(f"  connected to Fluoddity on port {port}")
        return client
    except Exception:                                           # noqa: BLE001
        print(f"  no Fluoddity on port {port}; click-to-load will copy paths")
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Browse captures, try captions, and run searches")
    parser.add_argument('folder', nargs='?',
                        help="folder of images to open (optional)")
    parser.add_argument('--config', help="search config for embedding "
                                         "settings and for launching searches")
    parser.add_argument('--port', type=int, default=8765,
                        help="Fluoddity API port for click-to-load")
    parser.add_argument('--caption', help="colour by this caption on open")
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

    viewer = Viewer(cfg=cfg, client=connect(args.port), port=args.port)
    viewer.config_path = args.config or ''
    if args.folder:
        viewer.load_folder(args.folder)
    if args.caption:
        viewer.caption = args.caption

    from imgui_bundle import immapp

    params = immapp.RunnerParams()
    params.app_window_params.window_title = "Fluoddity pilot"
    params.app_window_params.window_geometry.size = (1180, 900)
    params.callbacks.show_gui = viewer.draw
    # Idle when nothing moves: this sits open beside a search, and a viewer
    # spinning a GPU at full rate would compete with the thing it is watching.
    params.fps_idling.enable_idling = True
    params.fps_idling.fps_idle = 10.0
    immapp.run(params)
    return 0


if __name__ == '__main__':
    sys.exit(main())
