# CLIP-guided search — the plan

**Status: not built.** This records the design so the piloting API can be judged
against what it is actually for, and so the next conversation starts from
decisions already made rather than remaking them.

What exists today: [`../api/`](../api/) and [API.md](API.md) — the app can be
driven programmatically. [`../demos/tex_sim.py`](../demos/tex_sim.py) — a
working, standalone CLI that embeds, ranks, captions and clusters images. The
two have never been connected.

---

## The idea

Fluoddity's mutation space is large and unlabelled. Finding interesting
behaviour means looking at a lot of frames, and the looking is the bottleneck —
the simulation can produce candidates far faster than a person can judge them.

So: let a program do the looking. Render candidates, embed the frames, score
them against a text prompt or a reference image, and let the ranking steer which
part of mutation space gets explored next. The operator watches it happen and
intervenes when something looks promising.

---

## The boundary, and why it is where it is

**The app never imports torch.** That is the load-bearing statement of this
document.

Two processes:

```
   pilot process                        app process
   ─────────────                        ───────────
   torch, open_clip, numpy      HTTP    moderngl, glfw, imgui
   search strategy            ───────>  the simulation
   embeddings, scoring        <───────  PNG bytes / files
```

Three reasons, in order of how much trouble they save:

1. **Driver conflicts.** torch/CUDA and moderngl competing for the same GPU in
   one process is a category of problem that produces intermittent crashes with
   no useful stack trace. Separate processes make it someone else's scheduler
   problem.
2. **The pilot must be restartable.** Search strategies get rewritten
   constantly. Restarting the pilot without losing a running simulation — its
   loaded config, its checkpoint list, its warmed-up canvas — is the difference
   between an afternoon of iteration and an afternoon of waiting for startup.
3. **The app stays a desktop app.** It has no dependency on the search, and
   removing the search means deleting a directory that was never on the app's
   side of the wire.

This is also why the API is HTTP rather than a Python import: the boundary is
enforced by the transport, not by discipline.

---

## The seam

`tex_sim.py`'s entire contract with the outside world is one method:

```python
def embed_images(self, paths: list[Path]) -> np.ndarray:
    """Return (N, C, D) -- C crops/views per image, L2-normalized rows."""
```

It discovers images by walking a directory and caches embeddings per file, keyed
by `(resolved path, size, mtime)` — `file_key()` — into
`.texsim_cache/{backend}_{signature}.npz`. New images are cheap; changing a
backend hyperparameter changes `signature()` and therefore the cache file, so
stale embeddings cannot silently survive a configuration change.

**That means the integration works today with zero changes to `tex_sim.py`**:
the app writes PNGs to a folder, the pilot points `get_embeddings` at it. Start
there.

The one thing to add on the app side is **stable identity**. `Row.path` is the
only identifier that survives into the CSV and HTML output; nothing carries a
config id. A filename convention that encodes the candidate — seed, scale,
parent checkpoint — is the cheapest way to make results traceable back to the
state that produced them.

If disk round-trips later prove too slow, the seam to change is exactly one
method: an `embed_images(frames: list[np.ndarray])` variant fed by the API's
bytes-back capture, plus a replacement for `file_key`/`cache_path` (both
`Path.stat()`-bound) with a parameter hash. Do not do this speculatively — a
PNG write is microseconds next to a CLIP forward pass.

---

## Two backends, and when each is right

**`ClipBackend`** (`ViT-B-32` / `laion2b_s34b_b79k`) — semantic. Scores against
text. This is what makes "find me something that looks like coral" a query.

**`TextureBackend`** — no torch, interpretable, and arguably the better fit for
Turing-like patterns. Four concatenated blocks: radially-averaged FFT power
spectrum, angular power distribution, Euler-characteristic curve, intensity
histogram. The Euler curve is the interesting one:

> `chi(t) = components(fg) - holes(fg)` across intensity thresholds. Separates
> spots / labyrinths / inverted spots, which is exactly the Turing morphology
> axis.

`similar --backend texture --explain` against Fluoddity renders would rank
configs by characteristic wavelength and spot/labyrinth morphology, with no
model download and no GPU contention. **Worth trying first**, precisely because
it is cheap and its failures are legible.

---

## Two things about CLIP that change what the app should capture

**CLIP preprocesses to 224×224.** Capturing at 1024² for a whole-frame embedding
throws away 95% of the pixels. This is why [API.md](API.md)'s note about capture
resolution being resampling rather than detail matters less than it sounds —
for whole-frame scoring, window resolution is nearly irrelevant.

**Crops are how you make it describe texture rather than layout.** From
`tex_sim.py`'s own help: *"CLIP: embed N random crops per image instead of the
whole frame. 8–16 makes it describe local texture."* For a simulation whose
output is texture, this is the setting that matters, and it argues the *opposite*
way on resolution — a larger capture gives crops more to work with. Somewhere
around 512–768 square is likely the sweet spot. Measure it.

**Raw cosines are uninformative and must be calibrated.** `cmd_rank` scores
against 30 background captions and reports a robust z-score:

```python
med = np.median(bgs, 1)
mad = np.median(np.abs(bgs - med[:, None]), 1) * 1.4826
z = (s - med) / np.maximum(mad, 0.01)
```

with the printed warning *"rank by z, not raw cosine"*. Any scoring built on top
of this must do the same or the ranking is mostly measuring caption length.

---

## The part that is genuinely undesigned

**What "a direction in mutation space" means.** The API exposes the knobs —
`mutation_seed`, `mutation_scale`, `adopt_rule` via `select_particle_at`,
checkpoints — but which of them constitutes a *move*, and what a neighbourhood
looks like, is an open question. Some observations that constrain it:

- `mutation_seed` is an **opaque selector**, not a coordinate. Nearby seeds are
  not nearby behaviours; the hash sees to that. So there is no gradient to
  follow in seed space — only sampling.
- `mutation_scale` *is* a real axis: it controls how far cohorts spread from the
  base rule. Low scale is exploitation, high scale is exploration, and the
  search can move along it deliberately.
- `select_particle_at(index=N)` is the only genuine **hill-climbing move**:
  adopting a particle's mutated rule as the new base recentres the population
  around something the search liked. It changes exactly one field, which makes
  it clean to undo and clean to reason about. This is almost certainly the
  primitive the search should be built on.
- Checkpoints give **backtracking** for free, in-session and cheap.

A plausible first loop: checkpoint, adopt a well-scoring particle, reroll at
lower scale, render, score, keep or restore. Whether that is beam search,
evolutionary, or something simpler is the design conversation this document is
deferring, not answering.

**Also unanswered:** how long to run before capturing. Patterns take time to
develop and there is no reason to assume a fixed number of frames is right for
every config — a candidate might be scored at several timepoints, which makes a
schedule per candidate rather than a capture per candidate.

---

## First milestone

Small enough to learn something from:

1. Pick 50 existing configs from `configs/custom/`.
2. A schedule per config: load, reset, pin `physics_steps`, run 1000 frames,
   capture to `documents/sequences/<name>.png`, sleep.
3. `texsim rank --backend texture` over the folder against a reference image.
4. Look at the top 10 and the bottom 10 by eye.

If the ranking agrees with taste, the loop is worth closing. If it does not, that
is worth knowing before building a search on top of it — and it costs an
afternoon rather than a week.
