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
from contextlib import contextmanager
from pathlib import Path

import numpy as np

from . import clip_models
from . import embedding_cache
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

#: Where the fields point when nothing is given. The default run folder and
#: the shipped config, which is what a session almost always opens -- typing
#: the same two paths every time is friction for no reason. Only ever
#: defaults: whatever is in the boxes wins, and a missing path is reported
#: rather than assumed.
DEFAULT_FOLDER = 'documents/sequences/run/captures'
DEFAULT_CONFIG = 'search.json'
#: Offered in the config dropdown beside the box. Anything else can be typed.
KNOWN_CONFIGS = ('search.json', 'fan_search.json')

#: Quiet time before "live recolor" acts on a caption edit. Long enough that
#: typing a phrase does not fire once per keystroke, short enough that the
#: recolour feels like a consequence of stopping rather than a separate step.
#: Scoring itself is ~40ms on several thousand images, so the pause is what
#: the delay is for -- not the work.
LIVE_RECOLOR_DELAY = 0.15

#: Dropdown labels, in the order of gallery.SOURCES.
SOURCE_LABELS = ('CLIP embedding', 'Rule', 'Rule + sliders')


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
        # Pre-filled with the usual paths so a session is one click, not two
        # lines of typing. Nothing is loaded until Load is pressed.
        self.folder = DEFAULT_FOLDER
        self.config_path = DEFAULT_CONFIG

        #: The one piece of background work in flight, if any.
        self.task = None
        self.task_kind = ''

        self.pan = [0.0, 0.0]
        self.zoom = 1.0
        self.point_size = 4.0
        self.colour_mode = COLOUR_PLAIN
        self.status = 'no folder loaded'

        #: Which CLIP model the buttons here act with, as a short name.
        #: Follows the selected embedding set; falls back to the config.
        self.clip_model = clip_models.normalize(
            getattr(self.cfg, 'clip_model', None)) or clip_models.DEFAULT

        #: What the current folder's archive holds, as SignatureInfo. This is
        #: what replaced guessing: the sets are read off disk and listed, so
        #: loading one is a choice from a menu rather than an attempt to make
        #: a config match a forty-character key by hand.
        self.inventory = []
        #: Which folder `inventory` describes, so a stale list is never shown
        #: against the wrong folder.
        self.inventory_folder = ''
        #: The signature actually selected, '' when none is.
        #:
        #: OVERRIDES THE CONFIG FILE while the window is open, for all six
        #: cache-key fields. Every action re-reads the config first (see
        #: _refresh_config), so without this the file would undo the selection
        #: before the button acted on it -- pressing Re-score after choosing
        #: the SO400M set would score with whatever the file said and
        #: re-embed 25,100 images. The selection is an explicit act and wins.
        self.selected_signature = ''

        self.caption = ''
        self.caption_applied = ''
        self.caption_scores = None
        self.caption_calibrate = True
        #: Recolour on its own once typing pauses, rather than on a button.
        self.live_recolor = False
        #: When the caption last changed, or None when nothing is pending.
        #: Held rather than a deadline so the wait restarts on every keystroke
        #: -- otherwise a slow typist would trigger a recolour mid-word.
        self._caption_touched = None
        #: The caption the timer above is counting for, so an edit during the
        #: wait restarts it rather than firing on the older text.
        self._pending_caption = ''

        #: Percentile of the dataset to HIDE. A lens on the plot only: the
        #: layout and the percentile maths always use the full set, so moving
        #: this never reshuffles what survives.
        self.cutoff = 0.0
        self.cutoff_bottom = False

        self.n_neighbours = projection_lib.DEFAULT_NEIGHBOURS
        self.min_dist = projection_lib.DEFAULT_MIN_DIST
        self.seed = projection_lib.DEFAULT_SEED

        #: What the map is built from: the CLIP embedding of the picture, or
        #: the config's own numbers. Two genuinely different questions --
        #: "which look alike" versus "which ARE alike" -- and a pair that
        #: disagree is informative rather than a fault.
        self.source = gallery_lib.SOURCE_CLIP
        self.projected_source = ''

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

        # Each branch checks the result is the SHAPE it expects rather than
        # trusting task_kind. The two are set together and cannot normally
        # disagree, but "normally" is doing a lot of work there: a mismatch
        # would assign a string to self.projection and every later frame would
        # die inside the draw loop, far from the cause.
        if kind == 'scanning' and isinstance(progress.result, list):
            self._took_inventory(progress.result)
        elif kind == 'textmodel':
            self.backend = progress.result
            # Straight back into the caption the load was started for. Asking
            # the reader to press the button a second time, for a model they
            # just waited on, would be the machinery showing through.
            self.apply_caption()
        elif kind == 'loading' and isinstance(progress.result, tuple):
            self.gallery, self.backend = progress.result
            self.projection = None
            self.caption_scores = None
            self.caption_applied = ''
            self.textures.forget()
            self.colour_mode = (COLOUR_SCORE if self.gallery.has_scores
                                else COLOUR_PLAIN)
            self.status = (f"loaded {len(self.gallery)} images -- "
                           f"press Compute UMAP to project")
        elif kind == 'projecting' and isinstance(progress.result,
                                                 projection_lib.Projection):
            self.projection = progress.result
            self.n_neighbours = self.projection.n_neighbours
            self.pan, self.zoom = [0.0, 0.0], 1.0
            count = len(self.gallery) if self.gallery is not None else 0
            self.status = f"projected {count} points"
        elif kind == 'rescore' and isinstance(progress.result, dict):
            applied = 0
            if self.gallery is not None:
                applied = self.gallery.apply_scores(progress.result['scores'])
                # The run-score colouring now means the NEW objective, so
                # switch to it: leaving the map on a caption or on plain
                # would hide the thing the button was pressed to see.
                if applied:
                    self.colour_mode = COLOUR_SCORE
            self.status = (f"re-scored {progress.result['count']}; "
                           f"{applied} on the map; wrote "
                           f"{Path(progress.result['path']).name}")
        elif kind == 'searching':
            self.status = progress.result or "search finished"
        else:
            self.status = progress.latest or f"{kind} finished"

    # ------------------------------------------------------------------

    def _load_config(self, path, announce=True):
        """Read a search config. Reports failure rather than raising."""
        if not path:
            self.status = "no config path"
            return False
        try:
            self.cfg = SearchConfig.load(path)
        except Exception as e:                                  # noqa: BLE001
            self.status = f"could not read {path}: {e}"
            return False
        self.config_path = str(path)
        self._apply_model_choice()
        if announce:
            self.status = f"config: {self.cfg.describe_plan()}"
        return True

    def _apply_model_choice(self):
        """Reconcile the config just read with the selected embedding set.

        ONE DIRECTION, and that is the point. This used to arbitrate between a
        radio button and the file, with a hidden "pinned" flag deciding which
        won -- so the answer to "which model will this use" lived in a piece of
        state nothing on screen showed.

        Now a set is selected from the archive, and the six fields that make up
        its key are re-imposed over whatever the file says, every time the file
        is read. Without that, the re-read before each action would undo the
        selection and act on the file instead: choosing the SO400M set and
        pressing Re-score would score with the file's model and re-embed the
        whole folder. With no selection the file is simply the truth.

        SearchConfig is frozen, so this replaces it rather than mutating.
        """
        from dataclasses import replace

        settings = self._selected_settings()
        if settings is None:
            self.clip_model = (clip_models.normalize(self.cfg.clip_model)
                               or clip_models.DEFAULT)
            return
        fields = settings.as_config_fields()
        if any(getattr(self.cfg, k) != v for k, v in fields.items()):
            self.cfg = replace(self.cfg, **fields)
        if settings.clip_model:
            self.clip_model = settings.clip_model

    def _took_inventory(self, inventory):
        """Fold a finished scan in, and pick a set if the choice is obvious.

        AUTO-SELECTS ONLY THE UNAMBIGUOUS CASE -- exactly one complete set,
        which is the ordinary folder. With several, the best-covered one is
        selected but NOT loaded, so the reader sees the list and decides;
        quietly loading one of four would be the guessing this replaced.
        """
        self.inventory = inventory
        self.inventory_folder = self.folder
        self.gallery = None
        self.backend = None
        self.projection = None
        self.selected_signature = ''

        if not inventory:
            self.status = ("no embeddings in this folder -- "
                           "press Create embeddings")
            return

        complete = [info for info in inventory if info.complete]
        if len(complete) == 1 and len(inventory) == 1:
            self._select_set(complete[0])
            return

        best = complete[0] if complete else inventory[0]
        self.selected_signature = best.signature
        self._apply_model_choice()
        self.status = (f"{len(inventory)} embedding set(s) here -- "
                       f"{best.label} selected; press Load set")

    def _selected_settings(self):
        """VisionSettings for the selected set, or None if nothing is chosen."""
        if not self.selected_signature:
            return None
        return embedding_cache.parse_signature(self.selected_signature)

    def _selected_info(self):
        """The SignatureInfo for the selected set, or None."""
        for info in self.inventory:
            if info.signature == self.selected_signature:
                return info
        return None

    def _select_set(self, info):
        """Adopt a set's settings and load its vectors. No model is loaded."""
        self.selected_signature = info.signature
        self._apply_model_choice()
        self._load_selected()

    def _load_selected(self):
        """Load the selected set's vectors from the archive."""
        info = self._selected_info()
        if info is None or not self.folder:
            return
        folder, signature = Path(self.folder), info.signature
        aggregate = self.cfg.aggregate

        def work(report):
            gallery, missing = gallery_lib.build_cached(
                folder, signature, aggregate=aggregate, progress=report)
            return gallery, None

        if self._begin('loading', f"loading {info.label}", work):
            self.status = f"loading {info.covered} embeddings [{info.label}]"

    def _scan_folder(self, folder):
        """Read what the folder's archive holds. Cheap, and loads no model."""
        paths = gallery_lib.find_images(folder)
        return embedding_cache.EmbeddingCache(folder).inventory(paths)

    def _refresh_config(self):
        """Re-read the config file before acting on it.

        Every action that USES the config re-reads it first, so editing the
        JSON and pressing the button is the whole workflow -- pressing Reload
        in between was a step that existed only to remind the GUI of something
        the file already said, and forgetting it silently ran the OLD
        objective, which looks exactly like the action not working.

        Failure is not fatal: the config already in memory is a fine fallback,
        and refusing to run because a file was mid-save would be worse than
        running what was last read. The status line says which happened.
        """
        if not self.config_path:
            return True
        previous = self.cfg
        if self._load_config(self.config_path, announce=False):
            return True
        # _load_config already put the error in the status line.
        self.cfg = previous
        return False

    def load_folder(self, folder, config_path=None):
        """Read what a folder's archive holds. Embeds nothing, loads no model.

        THIS USED TO EMBED. Opening a folder built a backend and embedded
        whatever the config's key did not already cover -- so a config that
        disagreed with the archive by one field turned "look at this folder"
        into hours of GPU work, with a progress bar as the only clue. Loading
        now scans, lists the sets that are there, and waits to be told which
        one; making new ones is a button with its own name.
        """
        folder = Path(folder).expanduser()
        if not folder.is_dir():
            self.status = f"not a folder: {folder}"
            return
        if config_path and not self._load_config(config_path):
            return

        self.folder = str(folder)

        def work(report):
            report(f"  scanning {folder.name}")
            return self._scan_folder(folder)

        if self._begin('scanning', f"scanning {folder.name}", work):
            self.status = f"scanning {folder}..."

    def load_config_folder(self, folder):
        """Open a folder of Fluoddity save files. No images, no embedding.

        Synchronous, unlike load_folder: reading a few thousand small JSONs
        takes well under a second, and a background thread for that would be
        machinery around nothing.
        """
        folder = Path(folder).expanduser()
        if not folder.is_dir():
            self.status = f"not a folder: {folder}"
            return
        try:
            gallery = gallery_lib.build_configs(
                folder, progress=lambda m: setattr(self, 'status', m.strip()))
        except Exception as e:                                  # noqa: BLE001
            self.status = f"{type(e).__name__}: {e}"
            return

        self.folder = str(folder)
        self.gallery = gallery
        self.backend = None
        self.projection = None
        self.caption_scores = None
        self.caption_applied = ''
        self.textures.forget()
        self.colour_mode = COLOUR_PLAIN
        # CLIP cannot map a folder with no pictures, so do not leave the
        # dropdown pointing at a source that would only produce an error.
        if self.source == gallery_lib.SOURCE_CLIP:
            self.source = gallery_lib.SOURCE_RULE
        self.status = (f"{len(gallery)} configs -- press Compute UMAP "
                       f"(rule sources only)")

    def compute_projection(self):
        if self.gallery is None:
            self.status = "load a folder first"
            return
        gallery = self.gallery
        n, d, s = self.n_neighbours, self.min_dist, self.seed
        source = self.source

        def work(report):
            report(f"reading {source} features")
            # Built on the worker: 'rule' sources read a JSON per item, which
            # is thousands of small files and far too slow for a frame.
            features = gallery_lib.source_embeddings(gallery, source,
                                                     progress=report)
            report(f"projecting {len(features)} points")
            return projection_lib.project(features, n_neighbours=n,
                                          min_dist=d, seed=s)

        if self._begin('projecting', "projecting", work):
            self.projected_source = source
            self.status = f"projecting from {source}..."

    @property
    def stale(self):
        """True when the sliders no longer describe the plot on screen."""
        if self.projection is None:
            return False
        return (self.n_neighbours != self.projection.n_neighbours
                or abs(self.min_dist - self.projection.min_dist) > 1e-9
                or self.seed != self.projection.seed
                or self.source != self.projected_source)

    def apply_caption(self, may_load=False):
        """Colour the map by similarity to the typed caption.

        Cheap by design: the image embeddings are already in memory, so this
        is one text encode plus a matrix multiply -- measured at ~40ms across
        4,292 images. Trying twenty phrasings costs seconds, which is what
        makes this the right place to choose the negatives for a search.

        `may_load` is the button's privilege, not the typist's. A set opened
        from the archive has no backend -- that is the point of the picker --
        and the text side needs one. Pressing the button is a request to pay
        for it; a pause in typing is not, so live recolour never triggers a
        multi-gigabyte load from a keystroke.
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
            if may_load and self._load_text_model():
                # The load runs in the background; _collect calls back here
                # once the model is in hand.
                return
            self.status = ("captions need the model loaded -- press "
                           "Recompute colour from caption")
            return
        # Refused rather than silently scored with the wrong model. The
        # gallery's vectors and this backend's text vectors would be from two
        # different models, and their cosine is a plausible-looking number with
        # no meaning -- the one failure here that would not announce itself.
        #
        # Compared on the WHOLE signature, not just the architecture: crops and
        # grayscale change the vectors as surely as the model does, and the
        # old architecture-only check called those a match.
        if self.gallery.signature != self.backend.signature():
            self.status = (f"these vectors are {self.gallery.signature}, the "
                           f"model is {self.backend.signature()} -- select "
                           f"that set or create it")
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
        if imgui.button("Load captures"):
            self.load_folder(self.folder, self.config_path or None)
        _tip("Embed every IMAGE in this folder. Uses the shared cache, so a "
             "folder a search has already scored opens instantly.")

        imgui.same_line()
        if imgui.button("Load configs"):
            self.load_config_folder(self.folder)
        _tip("Read every Fluoddity save file in this folder and map them by "
             "what they ARE -- no rendering, no embedding, so it is instant.\n"
             "Hover shows the filename; clicking loads that save into a "
             "running Fluoddity. Only the Rule sources apply, since there is "
             "no picture.")

        imgui.set_next_item_width(520)
        _, self.config_path = imgui.input_text("config", self.config_path)
        imgui.same_line()
        if imgui.button("Reload##config"):
            self._load_config(self.config_path)
        _tip("A search config JSON. Supplies the embedding settings (backend, "
             "crops, grayscale) and is what a search launched here will run.\n"
             "Reload is only for SEEING the file's contents now -- re-score, "
             "report and search all re-read it themselves.")

        # The two shipped presets, one click each -- they are what a session
        # switches between, and retyping a filename to compare them is
        # friction with no purpose.
        for name in KNOWN_CONFIGS:
            imgui.same_line()
            if imgui.small_button(name):
                self.config_path = name
                self._load_config(name)

        if self.cfg is not None:
            imgui.text_disabled(f"config: {self.cfg.describe_plan()}")

        if self.gallery is not None:
            scored = 'scored' if self.gallery.has_scores else 'no scores'
            imgui.text_disabled(
                f"{len(self.gallery)} images, {scored}   "
                f"{self.gallery.signature}")

        # Loading is reported HERE rather than beside the action buttons: it
        # is what this panel started, and a bar next to the wrong control is a
        # bar about the wrong thing. Embedding 5,000 captures is minutes.
        if self.busy and self.task_kind in ('loading', 'projecting'):
            self._progress_bar(self.task_kind, self.task.progress)

    def _caption_panel(self):
        """Colour by a caption. The reason this tool earns its keep.

        Seeing WHICH cluster a caption lights up answers two questions a
        report cannot: whether the words mean what you think against these
        images, and what to put in negative_captions -- name the thing the
        search keeps rediscovering and you can subtract it.
        """
        from imgui_bundle import imgui

        imgui.set_next_item_width(380)
        changed, self.caption = imgui.input_text(
            "caption", self.caption,
            imgui.InputTextFlags_.enter_returns_true.value)
        # enter_returns_true means `changed` is True ONLY on Enter, so the
        # per-keystroke edits live recolor waits on have to be spotted by
        # comparing against what is on screen.
        if changed:
            # Enter is as deliberate as the button, so it may pay for the
            # model too -- the two are the same gesture.
            self.apply_caption(may_load=True)
            self._caption_touched = None
        _tip("Colour the points by similarity to this phrase. Enter applies "
             "it. Costs one text encode -- try a dozen.\n"
             "Loads the model first if it is not in memory, which the picker "
             "does not do; no images are re-embedded either way.")

        imgui.same_line()
        pending = self.caption.strip() != self.caption_applied
        if imgui.button("Recompute colour from caption"
                        + (" *" if pending and self.caption.strip() else "")):
            self.apply_caption(may_load=True)

        imgui.same_line()
        _, self.caption_calibrate = imgui.checkbox("calibrate",
                                                   self.caption_calibrate)
        _tip("Score against 30 generic background captions and report a robust "
             "per-image z, exactly as a caption search does.\n"
             "Off shows the raw cosine, which spans about two percent and "
             "mostly describes the caption rather than the image.")

        imgui.same_line()
        _, self.live_recolor = imgui.checkbox("live recolor",
                                              self.live_recolor)
        _tip(f"Recolour on its own once typing pauses for "
             f"{LIVE_RECOLOR_DELAY:.2f}s, instead of waiting for Enter or the "
             f"button. Scoring is ~40ms even on thousands of images, so the "
             f"pause is nearly all of the delay.")

        self._tick_live_recolor(pending)

        self._model_picker()
        self._colour_modes()
        self._cutoff()

    def _model_picker(self):
        """The embedding sets this folder holds, as a menu.

        WHAT THIS REPLACED. It was three radio buttons -- B32, L14, SO400M --
        and they could not express what the cache is actually keyed by. A set
        differing only in grayscale or crops read as a match, so the GUI said
        "SO400M" while the vectors it wanted were under a key one field away,
        and the miss looked exactly like a cold cache. The archive is the
        record of what exists, so it is what gets listed.

        HERE rather than beside the UMAP settings because this is a property of
        the SCORING, not of the layout: it decides what the caption box and
        Re-score mean.
        """
        from imgui_bundle import imgui

        imgui.text("embedding sets")
        imgui.same_line()
        if imgui.small_button("Rescan") and self.folder:
            self.load_folder(self.folder)
        _tip("Re-read this folder's archive. Embeds nothing.")

        if not self.inventory:
            imgui.text_disabled("  none -- press Create embeddings")
            return

        for info in self.inventory:
            selected = info.signature == self.selected_signature
            # The signature is the id, so two sets that decode to the same
            # label (an unrecognised model, say) stay separately clickable.
            if imgui.radio_button(f"{info.label}##{info.signature}", selected):
                self._select_set(info)
            _tip(f"{info.signature}\n\n"
                 f"{info.covered} of {info.total} images"
                 + (f"\n{info.entries} rows stored, {info.stale} unreachable"
                    if info.stale else "")
                 + "\n\nSelecting this loads its vectors and adopts its "
                   "settings. No model is loaded.")
            imgui.same_line()
            if info.complete:
                imgui.text_disabled(f"{info.covered}/{info.total} complete")
            else:
                imgui.text_disabled(
                    f"{info.covered}/{info.total} partial")
            if info.stale:
                imgui.same_line()
                imgui.text_disabled(f"+{info.stale} stale")

    def _set_actions(self):
        """Prune and delete for the selected set. Both touch the cache only."""
        from imgui_bundle import imgui

        info = self._selected_info()
        if info is None or not self.folder:
            return

        if info.stale:
            if imgui.small_button(f"Prune {info.stale} stale##prune"):
                self._prune_stale()
            _tip("Drop rows no file on disk can reach any more -- what a "
                 "rewritten capture leaves behind. The usable vectors stay.")
            imgui.same_line()

        if imgui.small_button("Delete set##delete"):
            self._delete_selected()
        _tip(f"Remove all {info.entries} rows for {info.label}.\n"
             "The images are untouched; only the embeddings go.")

    def _prune_stale(self):
        """Drop rows no load will ever read: unreachable, then duplicated.

        Both, because a reader looking at "+12,583 stale" does not care which
        kind they are -- and the two arise from the same event. A copy that
        shifts mtimes leaves duplicates; a rewrite that shifts them further
        leaves orphans.
        """
        folder = Path(self.folder)
        cache = embedding_cache.EmbeddingCache(folder)
        orphaned = cache.prune(gallery_lib.find_images(folder))
        duplicated = cache.compact()
        self.inventory = self._scan_folder(folder)
        self.status = (f"dropped {orphaned + duplicated} row(s) -- "
                       f"{orphaned} unreachable, {duplicated} duplicated")

    def _delete_selected(self):
        """Drop the selected set. Reloads the list; loads nothing."""
        info = self._selected_info()
        if info is None:
            return
        folder = Path(self.folder)
        embedding_cache.EmbeddingCache(folder).clear(info.signature)
        self.gallery = None
        self.projection = None
        self.selected_signature = ''
        self._took_inventory(self._scan_folder(folder))
        self.status = f"deleted {info.entries} row(s) -- {info.label}"

    def _load_text_model(self):
        """Load the model that made the LOADED vectors, for the text side.

        Started here, finished in _collect, which re-applies the caption. True
        if a load began.

        THE GALLERY'S SIGNATURE DECIDES, not the config's. A caption is scored
        by the cosine between its text vector and the image vectors on screen,
        so the model has to be the one that produced those -- and the config
        may say something else entirely by now. Taking the model from the
        gallery makes the mismatch impossible rather than merely detected.

        No images are embedded. The vectors are already in memory; this is the
        text tower's weights and nothing else.
        """
        from dataclasses import replace

        settings = embedding_cache.parse_signature(self.gallery.signature)
        if settings is None or not settings.clip_model:
            self.status = (f"cannot tell which model made "
                           f"{self.gallery.signature}")
            return False

        cfg = replace(self.cfg, **settings.as_config_fields())
        label = settings.clip_model

        def work(report):
            from . import embedding

            report(f"  loading {label} for the text side")
            return embedding.build_backend(cfg)

        if not self._begin('textmodel', f"loading {label}", work):
            return False
        self.status = (f"loading {label} to encode the caption "
                       f"(no images are embedded)...")
        return True

    def _tick_live_recolor(self, pending, now=None):
        """Recolour once the caption has been still for a moment.

        DEBOUNCED ON THE PAUSE, not throttled on a rate: recolouring every
        keystroke would score partial words ("a mea", "a mean", ...) and each
        result would be thrown away by the next letter. Waiting for the typing
        to stop scores the thing the user actually meant, once.

        The timer restarts on every edit rather than counting from the first,
        so a slow typist is not interrupted mid-phrase.

        Deliberately runs on the frame thread. Scoring is ~40ms on several
        thousand images, so it costs a few frames at idle -- putting it on a
        background thread would add a whole synchronization story for
        something already below the threshold of notice.
        """
        if not self.live_recolor:
            self._caption_touched = None
            return

        import time

        moment = time.monotonic() if now is None else now
        caption = self.caption.strip()

        if not pending or not caption:
            # Nothing outstanding -- either the colours already show this
            # caption, or the box is empty.
            self._caption_touched = None
            return

        if self._caption_touched is None or caption != self._pending_caption:
            self._caption_touched = moment
            self._pending_caption = caption
            return

        if moment - self._caption_touched >= LIVE_RECOLOR_DELAY:
            self._caption_touched = None
            self.apply_caption()

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

        with _disabled_if(not enabled):
            imgui.set_next_item_width(300)
            _, self.cutoff = imgui.slider_float(
                "percentile cutoff", self.cutoff, 0.0, 99.0, "%.0f%%")
            _tip("Hide all but the best slice of the current colour -- run "
                 "score or caption. 0 shows everything; 90 keeps the best "
                 "tenth. A lens only: the layout never moves when you drag "
                 "this."
                 if enabled else
                 "Needs something scored to rank by -- pick a colour mode or "
                 "apply a caption first.")

            imgui.same_line()
            _, self.cutoff_bottom = imgui.checkbox("bottom percentile",
                                                   self.cutoff_bottom)
            _tip("Keep the WORST slice instead of the best. Isolating "
                 "failures is how you find a negative caption worth "
                 "subtracting.")

        if enabled and self.cutoff > 0:
            mask = self.visible_mask()
            shown = int(mask.sum()) if mask is not None else len(self.gallery)
            end = "bottom" if self.cutoff_bottom else "top"
            imgui.same_line()
            imgui.text_disabled(f"{shown} shown ({end})")

    def _actions_panel(self):
        from imgui_bundle import imgui

        # Latched once for the whole panel: any of these buttons starts a task,
        # which would flip `busy` mid-panel and unbalance the disabled block.
        blocked = self.busy
        kind, task = self.task_kind, self.task

        with _disabled_if(blocked):
            if imgui.button("Write report"):
                self._write_report()
            _tip("Rank the run's manifest and write report.txt -- top 32 and "
                 "bottom 32 with scores, lineage and capture paths.")

            imgui.same_line()
            if imgui.button("Re-score run"):
                self._rescore()
            _tip("Score every capture against the config's objective and "
                 "update the map, the cutoff and report.txt.\n"
                 "Embeds no IMAGES -- the vectors are cached -- but it does "
                 "load the model, because the caption and the 30 calibration "
                 "captions have to be encoded.\n"
                 "RE-READS THE CONFIG FILE FIRST, so editing the JSON and "
                 "pressing this is the whole workflow.")

            imgui.same_line()
            selected = self._selected_info()
            partial = selected is not None and selected.partial
            label = (f"Continue embedding ({selected.missing} left)"
                     if partial else "Create embeddings")
            if imgui.button(label):
                self._create_embeddings()
            _tip(("Embed the images this set does not cover yet, under its "
                  "existing settings. The ones already done are not touched."
                  if partial else
                  "Embed this folder with the current config's vision "
                  "settings.\nTHE ONLY BUTTON HERE THAT LOADS A MODEL -- the "
                  "first time with a given model is a full pass over the "
                  "folder, minutes on thousands of captures.")
                 + "\nCached afterwards, so coming back to it is instant.")

            imgui.same_line()
            with _disabled_if(not self.cfg.has_search):
                if imgui.button("Run search"):
                    self._run_search()
            _tip("Launch a search with the config on disk -- it is re-read "
                 "first. Runs on a background thread; Fluoddity must be "
                 "running with --api-port."
                 if self.cfg.has_search else
                 "This config has no search section -- it can create "
                 "embeddings and re-score, but it does not describe a search.")

            if self.inventory:
                self._set_actions()

        # Loading and projecting report in the source panel, beside the
        # controls that start them; only this panel's own work reports here.
        if blocked and task is not None \
                and kind not in ('loading', 'projecting'):
            self._progress_bar(kind, task.progress)

    def _progress_bar(self, kind, progress):
        """A bar when the work can count itself, a spinner-ish line when not.

        Both matter: embedding and searching can say how far along they are,
        while projecting and reporting genuinely cannot -- UMAP is one opaque
        call. Showing a bar stuck at zero for those would be worse than
        showing none.
        """
        from imgui_bundle import imgui

        label = progress.label or kind
        if progress.fraction is None:
            imgui.text(f"{label}: {progress.latest}")
            return

        overlay = progress.detail or f"{progress.fraction * 100:.0f}%"
        imgui.progress_bar(progress.fraction, imgui.ImVec2(-1.0, 0.0), overlay)
        imgui.text_disabled(f"{label}: {progress.latest}")

    def _map_panel(self):
        from imgui_bundle import imgui

        count = len(self.gallery) if self.gallery is not None else 3

        imgui.set_next_item_width(200)
        current = list(gallery_lib.SOURCES).index(self.source)
        picked, choice = imgui.combo("UMAP source", current,
                                     list(SOURCE_LABELS))
        if picked:
            self.source = gallery_lib.SOURCES[choice]
        _tip("What the map is built FROM.\n\n"
             "CLIP embedding -- how the captures LOOK. Two configs land near "
             "each other when their pictures resemble each other.\n\n"
             "Rule -- the 80 Fourier coefficients. Near means the same "
             "behaviour, whatever it happens to look like.\n\n"
             "Rule + sliders -- the rule plus the physics settings (sensors, "
             "drag, gravity, trails). Excludes colour and mutation_seed: "
             "palette is appearance, and the seed is a hash input where "
             "nearby values mean nothing.\n\n"
             "The rule sources read each candidate's saved config, so they "
             "need a run folder with configs/.")

        imgui.same_line()
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
        # LATCHED, not re-read. begin_disabled/end_disabled must pair exactly,
        # and pressing the button starts a task -- so a second read of
        # self.busy would come back True and end a block that was never begun.
        blocked = self.busy
        with _disabled_if(blocked):
            if imgui.button(label):
                self.compute_projection()
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
        # A config-only gallery has nothing to show but the name, which is
        # why the name is the first line of every tooltip.
        if item.has_image:
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

        if self._send_config(target):
            return
        imgui.set_clipboard_text(str(target))

    def _send_config(self, target):
        """Load `target` into a running app. True if it went.

        SPLIT OUT OF _activate so it can be tested: the fallback path there
        calls imgui.set_clipboard_text, which segfaults the interpreter when no
        imgui context exists, taking any headless test of this logic with it.
        Everything that decides whether the app is reachable lives here and
        touches no imgui; _activate is left with the clipboard consolation and
        nothing else.
        """
        client = self._connected()
        if client is None:
            self.status = (f"no Fluoddity on port {self.port}; copied "
                           f"{Path(target).name}")
            return False
        try:
            client.load_config(target)
            self.status = f"loaded {Path(target).name} into Fluoddity"
            return True
        except Exception as e:                                  # noqa: BLE001
            # It answered /health a moment ago and has now failed, so it has
            # probably gone away since. Drop the client rather than keeping a
            # dead one: the next click re-probes and picks the app back up if
            # it returns, which is the whole point of connecting lazily.
            self.client = None
            self.status = f"could not load ({type(e).__name__}); copied path"
            return False

    def _connected(self):
        """A live client, connecting on demand. None if the app is not up.

        LAZY AND RETRIED, because the alternative was a one-shot probe at
        startup that never ran again: a pilot opened before Fluoddity -- or
        while it was still compiling shaders, which is most of a cold start --
        kept `client = None` for the rest of the session and reported "no app
        connected" on every click, however long the app had been running by
        then. Nothing short of restarting the pilot could fix it.

        The probe is a /health call, which the app answers off the frame loop
        and so stays fast even while it is parked. Cached once it succeeds, so
        a click is one request rather than two.
        """
        if self.client is not None:
            return self.client
        from .client import FluoddityClient

        client = FluoddityClient(port=self.port)
        try:
            client.health()
        except Exception:                                       # noqa: BLE001
            return None
        self.client = client
        return client

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
        # Re-read first: the report records the objective, and recording a
        # stale one would misdescribe the ranking it sits above.
        self._refresh_config()
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
        # THE point of re-scoring is to apply a changed objective, so reading
        # the file first is not a convenience -- without it the button scores
        # against whatever was loaded last and appears to do nothing.
        self._refresh_config()
        cfg = self.cfg

        def work(report):
            from . import report as report_lib

            folder = run_lib.RunFolder(root)
            # Deduped for the same reason the report dedupes: in folders
            # written before ids carried a session tag, only the last row for
            # an id describes the capture actually on disk.
            kept, _ = report_lib.dedupe(folder.read())
            report(f"re-scoring {len(kept)} captures")
            rescored = run_lib._rescore(kept, cfg, folder, progress=report)
            path = report_lib.write(
                folder.report, rescored, cfg=cfg, root=folder.root,
                title=f"Fluoddity search results -- {folder.root.name}")
            # Handed back so the PLOT follows too. Writing report.txt and
            # leaving the map showing the old ranking was the whole bug: the
            # new scores existed and nothing on screen used them.
            return {'scores': {c.id: c.score for c in rescored
                               if c.score is not None},
                    'path': str(path), 'count': len(rescored)}

        if self._begin('rescore', "rescore", work):
            self.status = "re-scoring..."

    def _create_embeddings(self):
        """Embed this folder. THE ONLY PLACE THE GUI LOADS A MODEL.

        Two jobs behind one button, because they are the same job:

        CREATE -- embed the folder under the current config's vision settings.
        CONTINUE -- when the selected set is partial, embed only what it does
        not cover, under ITS settings rather than the config's. embed_cached
        is misses-only already, so finishing a half-done set and starting a
        fresh one are the same call with a different key.

        A LOUD NO-OP when the set already exists and is complete. Silently
        re-embedding 25,100 images that are already on disk is the failure
        this whole panel was rebuilt to prevent, so it says so and selects the
        set instead.
        """
        if not self.folder:
            self.status = "load a folder first"
            return
        # Re-read so a config edited since the last load is honoured, exactly
        # as the other actions do; _apply_model_choice then re-imposes the
        # selected set on top of whatever the file said.
        self._refresh_config()

        selected = self._selected_info()
        if selected is not None and selected.partial:
            signature, label = selected.signature, selected.label
        else:
            settings = self._config_settings()
            if settings is None:
                self.status = (f"the {self.cfg.backend} backend has no "
                               f"embedding sets to create")
                return
            signature = embedding_cache.signature_for(settings)
            label = embedding_cache.label_signature(signature)
            match = next((i for i in self.inventory
                          if i.signature == signature), None)
            if match is not None and match.complete:
                self.selected_signature = match.signature
                self._load_selected()
                # AFTER the load, which sets a status of its own. The no-op is
                # the thing worth reading here: pressing Create and getting a
                # progress bar for work already done is what made a full cache
                # look like a cold one.
                self.status = (f"that set already exists and is complete -- "
                               f"{match.covered} images, same seed and "
                               f"settings! Loading it instead.")
                return

        folder, cfg = Path(self.folder), self.cfg

        def work(report):
            from . import embedding

            backend = embedding.build_backend(cfg)
            cache = embedding_cache.EmbeddingCache(folder)
            paths = gallery_lib.find_images(folder)
            embedding_cache.embed_cached(paths, backend, cache,
                                         progress=report)
            return self._scan_folder(folder)

        if self._begin('scanning', f"embedding {label}", work):
            self.selected_signature = signature
            self.status = f"embedding [{label}]..."

    def _config_settings(self):
        """VisionSettings the current config would embed under, or None.

        Built WITHOUT constructing a backend -- constructing one is the model
        load this exists to check before paying.
        """
        if self.cfg.backend != 'clip':
            return None
        try:
            model = clip_models.get(self.cfg.clip_model)
        except ValueError:
            return None
        return embedding_cache.VisionSettings(
            backend='clip', clip_model=model.key,
            crops=self.cfg.crops, crop_frac=self.cfg.crop_frac,
            seed=self.cfg.seed, grayscale=self.cfg.grayscale,
            architecture=model.architecture, pretrained=model.pretrained)

    def _run_search(self):
        from . import run as run_lib

        if not self.config_path:
            self.status = "load a search config first"
            return
        # A search runs for minutes off this config; re-reading it is the
        # difference between "the file says what runs" and "whatever was
        # loaded last does".
        self._refresh_config()
        cfg = self.cfg

        def work(report):
            report(cfg.describe_plan())
            search = run_lib.SearchRun(cfg, progress=report)
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


@contextmanager
def _disabled_if(condition):
    """Grey out the widgets inside, pairing begin/end_disabled structurally.

    Written as a context manager because the hand-rolled form is a live trap:
    the natural spelling reads the same expression twice --

        if self.busy: imgui.begin_disabled()
        if imgui.button(...): self.start_something()
        if self.busy: imgui.end_disabled()

    -- and pressing the button flips `busy` between the two, so end_disabled()
    fires without its begin and imgui asserts. Latching the condition once,
    here, makes that impossible to write.
    """
    from imgui_bundle import imgui

    if condition:
        imgui.begin_disabled()
    try:
        yield
    finally:
        if condition:
            imgui.end_disabled()


def connect(port):
    """A client for a running app, or None. Never raises.

    Only a courtesy at startup, so the console says whether the app was up.
    NOT the last word: the viewer re-probes on demand (see _connected), so
    starting Fluoddity after the pilot works without restarting anything.
    """
    from .client import FluoddityClient

    client = FluoddityClient(port=port)
    try:
        client.health()
        print(f"  connected to Fluoddity on port {port}")
        return client
    except Exception:                                           # noqa: BLE001
        print(f"  no Fluoddity on port {port} yet; click-to-load will connect "
              f"when one appears")
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

    # Falls back to the shipped config, then to sensible embedding settings, so
    # the GUI opens ready to load rather than needing a config chosen first.
    config_path = args.config or (DEFAULT_CONFIG
                                  if Path(DEFAULT_CONFIG).is_file() else None)
    if config_path:
        cfg = SearchConfig.load(config_path)
    else:
        cfg = SearchConfig(backend='clip', crops=6, crop_frac=0.5,
                           grayscale=True)
    from . import embedding
    problems = embedding.check_dependencies(cfg.backend)
    if problems:
        for problem in problems:
            print(problem)
        return 1

    viewer = Viewer(cfg=cfg, client=connect(args.port), port=args.port)
    if args.config:
        viewer.config_path = args.config
    if args.folder:
        # A folder on the command line loads immediately; without one the
        # fields sit pre-filled and wait for Load to be pressed.
        viewer.folder = args.folder
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
