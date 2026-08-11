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
    seed_configs: list = field(default_factory=list)

    # --- scoring ---
    #: 'texture' needs no torch and no download; 'clip' needs both.
    backend: str = "texture"
    #: Folder of images the search is trying to resemble.
    reference_dir: str = ""
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

    # ------------------------------------------------------------------

    @classmethod
    def load(cls, path):
        """Read a run config, ignoring unknown keys.

        Unknown keys are skipped rather than rejected so a config written by a
        newer version still opens, and so a user can leave notes in the file.
        """
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        known = {f.name for f in fields(cls)}
        unknown = sorted(set(data) - known)
        if unknown:
            print(f"search config: ignoring unknown keys {unknown}")
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self, path):
        """Write the config actually used. Called by the runner into the run
        folder, so a result is never separated from its settings."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(asdict(self), indent=2), encoding='utf-8')
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
        if self.children_per_parent == 0 and self.immigrants == 0:
            problems.append("children_per_parent and immigrants are both 0; "
                            "the search would produce nothing")
        if self.backend not in ('texture', 'clip'):
            problems.append(f"backend must be 'texture' or 'clip' "
                            f"(got {self.backend!r})")
        if self.reference_dir and not Path(self.reference_dir).is_dir():
            problems.append(f"reference_dir does not exist: {self.reference_dir}")
        if not 0.0 < self.world_size <= 4.0:
            problems.append(f"world_size out of range: {self.world_size}")
        return problems

    @property
    def candidates_per_generation(self):
        return self.beam_width * self.children_per_parent + self.immigrants
