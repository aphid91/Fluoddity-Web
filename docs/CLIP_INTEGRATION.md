# CLIP integration — status and background

**This is built.** See **[SEARCH.md](SEARCH.md)** for how to run a search, every
knob, and how to extend it.

This file keeps what SEARCH.md does not need to repeat: how the two processes
relate, what was measured on the way, and what is still open.

---

## The boundary

```
   pilot process                        app process
   ─────────────                        ───────────
   scipy / torch / numpy        HTTP    moderngl, glfw, imgui
   search strategy            ───────>  the simulation
   embeddings, scoring        <───────  PNG captures
```

**The app never imports torch, and `pilot/` never imports the app.** One
repository, two processes, and the HTTP API is the whole of the contact between
them.

Three reasons, in the order they will bite:

1. **Driver conflicts.** torch/CUDA and moderngl competing for one GPU in one
   process produces intermittent crashes with no useful stack trace.
2. **The pilot must be restartable.** Search strategies get rewritten
   constantly. Restarting the pilot without losing a warmed-up simulation is the
   difference between iterating and waiting.
3. **The app stays a desktop app.** Deleting `pilot/` leaves it untouched.

The transport enforces this rather than discipline doing it.

---

## What was measured

Recorded because each one changed a decision, and because re-deriving them costs
an afternoon.

**Throughput is bound by `advance()`, not by rendering.** Skipping the render
measured **6–9%** — inside the noise. A render-skipping fast-forward path was
planned, measured, and dropped: it would have saved ~20ms on a ~300ms candidate
while costing the ability to watch a run, which is the reason the app is not
headless in the first place.

**`world_size` is the real lever.** 0.1 gives 17,000 steps/s against 1,785 at
full size — a 10× difference that decides whether a generation takes seconds or
minutes. Full table in SEARCH.md.

**Which flips the bottleneck to the embedding.** At ~0.3s of simulation per
candidate, a per-candidate model call would cost more than the thing it
measures. Hence generation-batched embedding, and hence the composed
`evaluate_candidate` command — one HTTP round trip per candidate instead of six.

**`mutation_scale` is linear in distance** (0.19 / 0.38 / 1.34 / 3.82 at
0.05 / 0.1 / 0.35 / 1.0), so it is a genuine step-size dial rather than an
on/off. An earlier draft of this document claimed mutation space had "no
gradient to follow" — that is true of the *seed*, which is an opaque selector,
and wrong about the scale.

**A zero rule is immune to mutation.** The trap that would have made random
immigrants sterile. Described in SEARCH.md and asserted in `tests/test_moves.py`.

---

## About the backends

`demos/tex_sim.py` is the working implementation of both, and `pilot/embedding.py`
imports it rather than reimplementing it. Its hard-won details — the crop
sampling, the Euler-characteristic curve, the float32 discipline — are exactly
what a clean rewrite would quietly get wrong.

**`TextureBackend` is the default and needs no torch.** Four concatenated
blocks: radially-averaged FFT power, angular power distribution, an
Euler-characteristic curve, an intensity histogram. The Euler curve is the
interesting one:

> `chi(t) = components(fg) - holes(fg)` across intensity thresholds. Separates
> spots / labyrinths / inverted spots — the Turing morphology axis.

For a simulation whose output is texture, this is arguably a better match than a
semantic model, and its failures are legible in a way a neural embedding's are
not.

**`ClipBackend` understands text**, at the cost of a torch install and a model
download. Two things about it worth knowing before relying on it:

- **CLIP preprocesses to 224×224**, so capture resolution matters far less than
  instinct suggests for whole-frame scoring.
- **Crops are how you make it describe texture rather than composition.** From
  `tex_sim.py`'s own help: *"8–16 makes it describe local texture."* This is the
  setting that matters for this simulation, and it argues the opposite way on
  resolution — more pixels give the crops more to work with.

**Text scoring needs calibration, and the numbers say why.** Measured across 16
real captures against one caption, raw cosines spanned **0.18–0.25** — a
two-percent band, most of which describes the caption rather than the image.
The per-image background z-score used by `PromptScorer` widens that to a spread
of **2.88** and reorders the top five. `demos/tex_sim.py`'s `cmd_rank`
established the method; the search reuses its `BACKGROUND_CAPTIONS` rather than
inventing a second calibration set, and embeds them **once** so scores stay
comparable across generations (the beam holds survivors from any of them).

**Colour is a confound here, not a feature.** Particle hue comes from the same
behaviour output as motion, so palette and structure are coupled at the source
and a colour-sensitive model will happily rank a well-coloured mess above a
well-shaped one. `grayscale: true` desaturates references and candidates alike
before embedding. It applies only to CLIP — `TextureBackend` reads luminance
already — and `tests/test_search.py` asserts the colour-blind case end to end
by ranking a right-shape/wrong-colour image against a wrong-shape/right-colour
one.

`tex_sim.py`'s per-file embedding cache is deliberately **not** used by the
pilot: it keys on `(path, size, mtime)` to avoid re-embedding a stable corpus,
which is right for a CLI pointed at a photo library and wrong here, where every
capture is written once, embedded once, and never seen again.

---

## Still open

**Whether the objective tracks taste.** The measured smoke run produced 19
distinct scores that visually separated structured patterns from featureless
blobs. That is the scorer being *discriminating*; it is not evidence that it is
*right*. The check in SEARCH.md — rank configs you already have, look at both
ends — is the one that decides this, and it has not been done with a real
reference set.

**Whether CLIP says anything useful about abstract texture.** `PromptScorer`
ships, and the answer so far is *partly*, with a caveat worth taking seriously.

Asked to RANK a fixed set of 16 captures against *"a dense tangled web of
filaments"*, it put a genuinely filamentary image first and structureless noise
last — a sensible ordering. Asked to DRIVE a search with the same caption, it
climbed cleanly (+3.92 → +4.84 over two generations) and converged on a dense
speckled disc, which is not a web of filaments.

So the objective is strong enough to optimize against without being faithful to
the words. That is the classic shape of a proxy objective, and it means a
caption run needs eyeballing after a couple of generations rather than being
left overnight on trust.

Still unmeasured: a head-to-head against `ReferenceImageScorer` on identical
captures, which is what would actually settle which objective to prefer.

**Novelty and quality-diversity.** Both fit the shipped interfaces without
changing them — see the stubs in `pilot/scoring.py` and the note in
`pilot/search.py`. The one real design question is whether a novelty archive
holds every candidate (unbounded) or only survivors (biased toward what the beam
already liked).

**Multi-timepoint evaluation.** A candidate is currently judged from one capture
at a fixed step count. A pattern that looks good at 2000 steps and dies by
10,000 scores the same as one that persists. Capturing at several timepoints
would catch that and give a stability signal for free, at roughly one extra
`run_steps` per capture.
