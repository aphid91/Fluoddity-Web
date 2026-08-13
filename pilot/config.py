"""Everything a run is allowed to vary, in one place.

Every number the search depends on lives here rather than in the code that uses
it, for one reason: a run's `search.json` is written into its output folder, so
a result can always be traced to the exact settings that produced it. A constant
buried in a module cannot be recovered that way.

Defaults are the measured ones -- see docs/SEARCH.md for where they come from.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from . import clip_models

#: Relative paths in a config resolve against the repo root, not the working
#: directory -- the app already refuses to depend on CWD, and a pilot launched
#: from elsewhere must not see a different filesystem.
_REPO_ROOT = Path(__file__).resolve().parent.parent

#: How the fields group when a config is written nested. One source of truth:
#: `_migrate` flattens by it, `save` nests by it, and the GUI asks it whether a
#: file describes a search at all.
#:
#: SEED AND CROP_FRAC ARE VISION FIELDS, however much they read like search
#: knobs. Both are in the embedding cache key, so moving `seed` into `search`
#: would silently default it to 0 and orphan every set embedded with another
#: value -- hours of GPU time lost to a field that looked like it belonged
#: somewhere else.
SECTIONS = {
    'vision': ('backend', 'clip_model', 'crops', 'crop_frac', 'grayscale',
               'seed'),
    'scoring': ('captions', 'negative_captions', 'caption_aggregate',
                'reference_dir', 'calibrate', 'aggregate'),
    'search': ('run_dir', 'resume', 'port', 'world_size', 'cohorts',
               'physics_steps', 'warmup_steps', 'capture_size',
               'mutation_scale', 'generations', 'beam_width',
               'children_per_parent', 'immigrants', 'seed_configs',
               'sample_size'),
}


@dataclass(frozen=True)
class SearchConfig:
    """One run's settings."""

    # --- output ---
    #: Run folder. Everything the run produces lands under here.
    run_dir: str = "documents/sequences/run"
    #: Resume from an existing run_dir rather than refusing to overwrite it.
    resume: bool = False

    # --- the app ---
    port: int = 8765
    #: Set ONCE per run, never per candidate: world_size is disruptive (it
    #: reallocates GPU buffers and restarts the simulation), so changing it
    #: mid-run would cost seconds and reset the thing being measured.
    #:
    #: 0.1 is ~60k entities on a 323^2 canvas: measured 17,000 physics steps/s,
    #: so a 5000-step candidate is under a third of a second of simulation.
    #: At 1.0 the same candidate costs 2.8s -- a 10x difference that decides
    #: whether a generation takes seconds or minutes.
    world_size: float = 0.1

    #: REQUIRED BY THE MOVE RECIPE, and not really a knob. At cohorts=1 every
    #: particle carries the identical rule, which is what makes "select an
    #: arbitrary particle" well-defined. Raise it and selection starts picking
    #: between genuinely different behaviours, so a candidate stops being one
    #: point in mutation space.
    cohorts: int = 1

    #: Physics sub-steps per displayed frame. Only affects what the operator
    #: sees BETWEEN candidates -- warmups go through run_steps, which counts
    #: steps directly and ignores this.
    physics_steps: int = 30

    # --- evaluating a candidate ---
    #: Physics steps before capture. THE throughput lever: at world_size 0.1
    #: this is ~0.29s per candidate, and it scales linearly.
    warmup_steps: int = 5000
    #: Capture resolution. Above CLIP's 224^2 preprocess so that crop-based
    #: texture embedding has real pixels to work with. The window is set to
    #: this once per run, so captures are native rather than resampled.
    capture_size: int = 512

    # --- the move ---
    #: How far a child steps from its parent. Measured as a clean linear dial:
    #: L2 distance from the parent rule is ~0.19 / 0.38 / 1.34 / 3.82 at
    #: 0.05 / 0.1 / 0.35 / 1.0.
    mutation_scale: float = 0.35

    # --- the search ---
    generations: int = 10
    #: Survivors carried into the next generation.
    beam_width: int = 8
    #: Mutant children produced from each survivor.
    children_per_parent: int = 4
    #: Fresh random behaviours per generation. NONZERO ON PURPOSE: a beam that
    #: has converged on a dead end has no way out on its own, because every
    #: child is a small step from something already in the beam. Immigrants are
    #: the only source of genuinely new rules.
    immigrants: int = 4
    #: Configs to start generation 0 from. Empty means start from immigrants.
    #:
    #: ENTRIES MAY BE FOLDERS. Any directory expands to every .json inside it,
    #: sorted, so a folder of favourites is one line rather than fifty. Files
    #: still work and the two can be mixed -- there is no second field to keep
    #: in step, and an existing config keeps loading unchanged.
    seed_configs: list = field(default_factory=list)

    #: How many random rules to draw for generation 0 when there are no
    #: seed_configs. 0 means "as many as the beam holds", which is the old
    #: behaviour and the right default for a search -- generation 0 exists to
    #: fill the beam, so drawing more would be wasted work.
    #:
    #: Set it when generation 0 IS the point: a pure sampling run wants a
    #: number chosen for coverage, not one inherited from the beam. Ignored
    #: when seed_configs is non-empty, since then generation 0 is the seeds.
    sample_size: int = 0

    # --- scoring ---
    #: 'texture' needs no torch and no download; 'clip' needs both.
    backend: str = "texture"

    #: WHICH CLIP model, by short name -- 'B32', 'L14' or 'SO400M'. See
    #: pilot/clip_models.py for what each one actually loads and why the config
    #: says a short name rather than an open_clip architecture/checkpoint pair.
    #:
    #: Ignored by the texture backend, which has no model to choose.
    #:
    #: CHANGING THIS INVALIDATES NOTHING AND RECOMPUTES EVERYTHING. The model
    #: name is part of the embedding cache key, so switching to L14 re-embeds
    #: the folder and switching back to B32 finds the old vectors still there.
    #: Scores from two models are NOT comparable -- different vector spaces --
    #: so a report written under one says which model produced it.
    clip_model: str = "B32"
    #: Folder of images the search is trying to resemble.
    reference_dir: str = ""

    #: Text prompts to search toward. CLIP only, and mutually exclusive with
    #: reference_dir -- two objectives at once is a run whose results cannot be
    #: attributed to either.
    #:
    #: A LIST OR A BARE STRING; load() accepts either, so "captions": "a river"
    #: and "captions": ["a river", "a delta"] both work. Several phrasings of
    #: the same idea usually beat one: CLIP is sensitive to wording, and
    #: "a meandering river" / "a verdant river delta" / "branching channels"
    #: between them describe the thing more robustly than any one of them.
    captions: list = field(default_factory=list)

    #: How several positive captions combine. 'max' by default: a candidate
    #: scores well if it matches ANY of the phrasings, which is what a set of
    #: alternative descriptions means. 'mean' scores the centroid instead --
    #: it demands a candidate match all of them at once, and the centroid of
    #: several captions can land somewhere resembling none of them. 'topk'
    #: averages the best third.
    caption_aggregate: str = "max"
    #: Things to search AWAY from. The caption says what you want; these say
    #: what you keep getting instead, and their similarity is subtracted. The
    #: most direct lever for pushing a search out of a rut it keeps
    #: rediscovering.
    negative_captions: list = field(default_factory=list)
    #: Calibrate the caption score against generic background captions.
    #: ON BY DEFAULT AND SHOULD STAY ON. Raw CLIP cosines occupy a band about
    #: two percent wide, most of which describes the caption rather than the
    #: image -- measured, four visually distinct captures scored 0.2173 /
    #: 0.2123 / 0.1971 / 0.1962 against one caption. Ranking on that is
    #: mostly ranking noise. Turn it off only to see that for yourself.
    calibrate: bool = True
    #: CLIP only: crops per image. 8-16 makes it describe local texture rather
    #: than global composition, which is what matters for this simulation.
    crops: int = 1
    crop_frac: float = 0.3

    #: Desaturate every image before embedding -- references and candidates
    #: alike -- so scoring follows structure rather than palette.
    #:
    #: WHY THIS EXISTS. Particle colour in Fluoddity is driven by the same
    #: behaviour output that drives motion, so hue and shape are coupled at the
    #: source. In colour, a config that happens to land on a palette close to
    #: the references scores well whatever it is doing spatially -- which is
    #: how random noise of the right colour outranks a genuinely good pattern,
    #: and the search then optimizes toward the palette.
    #:
    #: ONLY AFFECTS THE CLIP BACKEND. The texture backend already works from
    #: luminance alone (its _load_gray converts to "L"), so it is grayscale
    #: whatever this says -- and is worth trying first for exactly that reason.
    grayscale: bool = False
    #: How per-crop similarities combine: mean, max, or topk.
    aggregate: str = "mean"

    #: Seeds the strategy's own RNG, so a whole run replays from search.json.
    seed: int = 0

    #: Which top-level sections the FILE this came from actually had. Empty
    #: for a flat file -- which by definition supplied everything -- and for a
    #: config built in code. Describes the file, not the run, so `save` leaves
    #: it out.
    #:
    #: OUT OF EQUALITY (compare=False) for the same reason. Saving nests, so a
    #: config would otherwise never equal its own round-trip -- two objects
    #: agreeing on every setting that affects a run, called different because
    #: of how one of them was punctuated on disk.
    sections: tuple = field(default=(), compare=False)

    # ------------------------------------------------------------------

    @property
    def has_search(self):
        """Whether this config describes a search, not just how to embed.

        False ONLY for a nested file that omitted the `search` section. A flat
        file has every field and a config built in code takes the defaults, so
        both can search; it is the deliberate omission that cannot.
        """
        return not self.sections or 'search' in self.sections

    @classmethod
    def load(cls, path):
        """Read a run config, nested or flat, ignoring unknown keys.

        Unknown keys are skipped rather than rejected so a config written by a
        newer version still opens, and so a user can leave notes in the file.
        """
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        # Which sections the FILE had, read before the migration flattens
        # them away. This is the only way to tell "omitted the search section"
        # from "wrote every field at its default", and it is what lets a
        # vision-only config embed and re-score without pretending to describe
        # a search.
        present = tuple(name for name in SECTIONS
                        if isinstance(data.get(name), dict))
        data = cls._migrate(data)
        known = {f.name for f in fields(cls)}
        # Keys starting with '_' are comments -- JSON has none, the shipped
        # configs are full of them, and warning about them every load trains
        # the reader to ignore the warning that matters.
        unknown = sorted(k for k in set(data) - known if not k.startswith('_'))
        if unknown:
            print(f"search config: ignoring unknown keys {unknown}")
        values = {k: v for k, v in data.items() if k in known}
        values['sections'] = present
        return cls(**values)

    @staticmethod
    def _migrate(data):
        """Accept older and looser spellings, so a config never just breaks.

        NESTED OR FLAT. A config may group its fields under `vision`,
        `scoring` and `search`, which is what makes "these are the settings
        that made those embeddings" a thing you can see at a glance rather
        than reconstruct from a flat list of thirty keys. The sections are
        flattened here, so the dataclass stays flat and nothing downstream
        needs to know which shape the file was in. A top-level key wins over
        the same key inside a section, so an override still works.

        `caption` (a single string) predates `captions`. Rather than carry two
        fields meaning almost the same thing -- which every future reader would
        have to check, and the docs explain -- it is folded into the list on
        read. A bare string in `captions` is accepted for the same reason: it
        is the obvious thing to write for one caption, and refusing it would be
        pedantry.
        """
        data = dict(data)
        for name in SECTIONS:
            block = data.pop(name, None)
            if isinstance(block, dict):
                for key, value in block.items():
                    data.setdefault(key, value)
        single = data.pop('caption', None)
        if single and not data.get('captions'):
            data['captions'] = [single]
        captions = data.get('captions')
        if isinstance(captions, str):
            data['captions'] = [captions] if captions else []
        negatives = data.get('negative_captions')
        if isinstance(negatives, str):
            data['negative_captions'] = [negatives] if negatives else []
        # Canonicalize the model name HERE, at the one boundary a config
        # crosses, so everything downstream -- the signature, the cache key,
        # the report, the GUI radio -- compares against one spelling. A config
        # written "ViT-L/14" then behaves identically to one written "L14"
        # instead of quietly missing the cache. An unrecognized name is left
        # alone for validate() to report by its original spelling.
        model = data.get('clip_model')
        if model is not None:
            data['clip_model'] = clip_models.normalize(model) or model
        return data

    @classmethod
    def _check_sections(cls):
        """Every field belongs to exactly one section. Raises if not.

        Checked at import rather than trusted: a field added without a section
        would be dropped silently by `save`, and the loss would only surface
        as a run that behaved unlike the config that produced it.
        """
        known = {f.name for f in fields(cls)} - {'sections'}
        mapped = [key for keys in SECTIONS.values() for key in keys]
        missing = known - set(mapped)
        if missing:
            raise RuntimeError(
                f"config fields in no SECTIONS group: {sorted(missing)}")
        extra = set(mapped) - known
        if extra:
            raise RuntimeError(f"SECTIONS names non-fields: {sorted(extra)}")
        if len(mapped) != len(set(mapped)):
            raise RuntimeError("SECTIONS lists a field in two groups")

    @property
    def caption(self):
        """The first positive caption, or ''. For callers that want one."""
        return self.captions[0] if self.captions else ''

    def save(self, path, nested=True):
        """Write the config actually used. Called by the runner into the run
        folder, so a result is never separated from its settings.

        NESTED by default, which is also the shape the reader is invited to
        write. `sections` is left out: it describes the file this was read
        from, not the run, and writing it would make a saved config claim its
        own provenance.
        """
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = asdict(self)
        data.pop('sections', None)
        if nested:
            data = {name: {key: data[key] for key in keys}
                    for name, keys in SECTIONS.items()}
        target.write_text(json.dumps(data, indent=2), encoding='utf-8')
        return target

    def validate(self):
        """Complain about settings that cannot work, before the app starts.

        Cheap checks only, and all of them things that would otherwise fail
        deep inside a run: a bad reference folder after ten minutes of
        evaluation is a bad way to find out.
        """
        problems = []
        if self.cohorts != 1:
            problems.append(
                f"cohorts must be 1 for the move recipe to be well-defined "
                f"(got {self.cohorts}); at higher values a selected particle "
                f"is one of several different behaviours")
        if self.warmup_steps < 1:
            problems.append(f"warmup_steps must be >= 1 (got {self.warmup_steps})")
        if self.beam_width < 1:
            problems.append(f"beam_width must be >= 1 (got {self.beam_width})")
        if self.children_per_parent < 0 or self.immigrants < 0:
            problems.append("children_per_parent and immigrants must be >= 0")
        if self.sample_size < 0:
            problems.append(f"sample_size must be >= 0 (got {self.sample_size})")
        # children_per_parent and immigrants may BOTH be zero: that is a
        # sampling run, where generation 0 is the whole point and there is
        # deliberately nothing after it. Only complain if such a run would also
        # produce no generation 0 -- i.e. nothing at all.
        if (self.children_per_parent == 0 and self.immigrants == 0
                and self.generations > 1):
            problems.append(
                f"children_per_parent and immigrants are both 0, so nothing "
                f"is produced after generation 0 -- set generations to 1 "
                f"(got {self.generations}) or give the search something to "
                f"breed")
        if self.backend not in ('texture', 'clip'):
            problems.append(f"backend must be 'texture' or 'clip' "
                            f"(got {self.backend!r})")
        # Checked even for the texture backend, which ignores the field: a
        # config with a typo'd model name is wrong whether or not this
        # particular run would have loaded it, and saying so now is better than
        # the first time someone flips backend to clip.
        if clip_models.normalize(self.clip_model) is None:
            problems.append(
                f"clip_model must be one of "
                f"{', '.join(clip_models.keys())} (got {self.clip_model!r})")
        if self.reference_dir and not Path(self.reference_dir).is_dir():
            problems.append(f"reference_dir does not exist: {self.reference_dir}")

        # Objective: at most one, and captions need a model that reads text.
        if not isinstance(self.captions, (list, tuple)):
            problems.append("captions must be a list of strings")
        if not isinstance(self.negative_captions, (list, tuple)):
            problems.append("negative_captions must be a list of strings")
        if self.captions and self.reference_dir:
            problems.append(
                "set either captions or reference_dir, not both -- with two "
                "objectives a result cannot be attributed to either")
        if self.captions and self.backend != 'clip':
            problems.append(
                f"caption scoring needs backend='clip' (got "
                f"{self.backend!r}); the texture backend cannot embed text")
        if self.negative_captions and not self.captions:
            problems.append("negative_captions needs a caption to subtract from")
        if self.caption_aggregate not in ('mean', 'max', 'topk'):
            problems.append(f"caption_aggregate must be mean, max or topk "
                            f"(got {self.caption_aggregate!r})")
        if not 0.0 < self.world_size <= 4.0:
            problems.append(f"world_size out of range: {self.world_size}")
        return problems

    @property
    def candidates_per_generation(self):
        """Candidates in a BREEDING generation (1 and later)."""
        return self.beam_width * self.children_per_parent + self.immigrants

    @property
    def generation_zero_size(self):
        """Candidates in generation 0, which is a different shape.

        Generation 0 is seeds if there are any, and otherwise a draw of random
        rules -- never the beam x children arithmetic that governs the rest.
        Worth its own property because a sampling run's whole output is this
        number, and reporting the breeding size instead would be wrong by
        orders of magnitude.
        """
        if self.seed_configs:
            # Counted through the expansion, so a folder reports the number of
            # configs in it rather than 1 -- the banner would otherwise
            # under-report a run by a factor of fifty.
            return len(self.expand_seed_configs(self.seed_configs))
        return self.sample_size or max(self.beam_width, self.immigrants)

    @staticmethod
    def expand_seed_configs(entries):
        """Resolve seed_configs, expanding any folder to the .json files in it.

        A folder of favourites is one line rather than fifty, and dropping a
        file into it changes the next run without editing anything.

        Sorted within each folder, so generation 0 evaluates them in a stable
        order and two runs of one config produce the same ids. NOT recursive:
        a folder means the configs in it, not a tree the user may not have
        meant to sweep.
        """
        out = []
        for entry in entries or []:
            path = Path(entry).expanduser()
            if not path.is_absolute():
                path = _REPO_ROOT / path
            if path.is_dir():
                found = sorted(path.glob('*.json'))
                if not found:
                    print(f"  seed_configs: no .json in {path}")
                out.extend(found)
            else:
                out.append(path)
        return out

    @property
    def is_sampling_run(self):
        """True when this run only draws random rules and stops."""
        return (self.generations <= 1
                and not self.seed_configs
                and self.children_per_parent == 0)

    def describe_plan(self):
        """One line saying what this config will actually do."""
        if self.is_sampling_run:
            return f"sample {self.generation_zero_size} random rules"
        # generation_zero_size, not len(seed_configs): an entry may be a
        # FOLDER, and reporting "1 seed config" for a directory of fifty
        # under-states the run by a factor of fifty.
        first = (f"{self.generation_zero_size} seed config(s)"
                 if self.seed_configs
                 else f"{self.generation_zero_size} random rules")
        if self.generations <= 1:
            return f"evaluate {first}"
        return (f"{first}, then {self.generations - 1} generation(s) of "
                f"{self.candidates_per_generation} candidates")


#: Checked once, at import: a field with no section would be dropped by save.
SearchConfig._check_sections()
