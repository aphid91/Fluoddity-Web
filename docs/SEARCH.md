# Automated search over mutation space

An external program that drives Fluoddity, captures candidates, scores them by
similarity to images you like, and steers the next generation toward what scored
well. You watch it work.

```bash
# terminal 1
python main.py --api-port 8765

# terminal 2
python -m pilot.run --write-example search.json     # then edit reference_dir
python -m pilot.run --config search.json
```

Requires `scipy` for the default texture backend (`pip install scipy`), or
`torch` + `open_clip_torch` for `backend: "clip"`. Missing dependencies are
reported before the run starts, not partway through.

---

## The move

This is the whole idea, and it is mechanical.

A candidate is evaluated at **`cohorts = 1`, `mutation_scale = 0`**: every
particle obeys one rule, so the picture shows one behaviour rather than a blend.
To produce a child:

```
mutation_scale = S      the population fans out around the current rule
select particle #0      adopt one of those variants as the new base rule
mutation_scale = 0      collapse back to a single behaviour
reset + warmup          grow the pattern from a clean canvas
capture                 the picture that gets embedded
```

Siblings come from rerolling `mutation_seed` before the same step. The parent is
checkpointed first, so every child starts from the same state and differs only
in its seed.

### Three things that make this work

**Index 0 is arbitrary by construction.** `get_cohort()` returns
`cohorts * index / count` — a fraction in `[0,1)` — and the shader floors it. At
`cohorts = 1` every particle in the buffer resolves to cohort 0 and carries the
identical rule. Verified across the whole buffer in `tests/test_moves.py`; there
is genuinely nothing to choose between particles, so no GPU pick is needed and
selection is synchronous and exact.

**`mutation_scale` is a linear step size.** Measured L2 distance from the
parent rule:

| scale | 0.05 | 0.1 | 0.35 | 1.0 |
|---|---|---|---|---|
| distance | 0.19 | 0.38 | 1.34 | 3.82 |

So annealing it over generations is well-founded, if you want that later.

**The move is deterministic.** Given `(parent, scale, seed)` the child is
reproducible exactly, which is why the manifest records all three.

### Generations are numbered from 0

| generation | what it is | how many |
|---|---|---|
| **0** | seed configs, or random rules if there are none | `len(seed_configs)`, else `sample_size` (or `max(beam_width, immigrants)`) |
| **1+** | children of the beam, plus immigrants | `beam_width × children_per_parent + immigrants` |

So `generations: 1` runs **only generation 0** — it evaluates its starting
points and stops. `generations: 2` adds one round of breeding.

### Two presets

**`search.json`** — a multi-generation beam search. Hill-climbs: keep the best
K, breed M children each, repeat.

**`fan_search.json`** — explores wide rather than deep. As shipped it is a
**pure sampling run**: draw `sample_size` random rules, score them all, stop.

```json
"generations": 1,
"sample_size": 200,
"seed_configs": [],
"children_per_parent": 0,
"immigrants": 0
```

`sample_size` is the only knob that changes the count. Nothing breeds, so
nothing is checkpointed — a run drawing thousands of rules would otherwise
accumulate a whole project per candidate inside the app for no reason.

**To fan instead of sample**, set `generations: 2` and
`children_per_parent > 0`, and optionally fill `seed_configs`. Generation 0 then
evaluates the seeds (or `sample_size` random rules) unchanged, and generation 1
fans every survivor out. Keep `beam_width` at least the number of seeds, or the
worst-scoring ones are culled before they ever breed.

The run prints what it will do before it starts:

```
search: sample 200 random rules (~2000 steps each)
search: 4 seed config(s), then 1 generation(s) of 68 candidates (~2000 steps each)
```

**A random sample is not a zero-rule seed.** Each immigrant adopts its generated
rule the moment it is made, so it is a normal population member before it is
ever scored — see below.

### Seeding from an all-zero rule

A config whose rule is all zeros is the engine's **"no behaviour authored"**
sentinel, and it is a legitimate thing to seed a search with — it means "start
from anywhere".

The move behaves differently there, correctly but not obviously:

- **`mutation_scale` is ignored**, and the app pins it to 0. There is nothing to
  step *from*, because the shader generates a rule from `mutation_seed` rather
  than reading one, and generated rules are never mutated (measured: identical
  output at scale 0.0, 0.2, 0.5 and 1.0).
- **Each child is an independent random rule**, not a small step. Measured
  pairwise L2 between siblings: **9.9–12.2**, against **0.87–1.06** for children
  of an authored parent at scale 0.2.
- **Children are not sterile.** Selecting the particle writes the generated rule
  in as a real one, so every child leaves the sentinel behind and mutates
  normally from then on.

So generation 1 from a zero-rule seed is *random sampling*; generation 2 onward
is a real search. Rows produced this way record `mutation_scale: 0.0` and carry
`extra.from_zero_rule` in the manifest, so a report never claims a scale that
had no effect.

### The zero-rule trap

An all-zero rule is a **sentinel** meaning "no behaviour authored": the shader
generates one from `mutation_seed` instead of reading one, and **generated rules
are never mutated**. Measured: scale 0.35 and scale 1.0 on a zeroed config give
byte-identical results.

`randomize_behavior` produces exactly this state — so a naive random immigrant
would be **permanently sterile**, ignoring every mutation forever, in a way that
looks like the mutation rate being broken.

The app's `fresh_candidate` defuses it by adopting once, which writes the
generated rule into the config as a real rule. `tests/test_moves.py` asserts the
trap still exists, so if the shader's generate-vs-mutate branch ever changes,
that test fails and tells you the workaround can go.

---

## Throughput

Measured, bare `advance()`:

| world_size | entities | canvas | steps/s | 5000 steps |
|---|---|---|---|---|
| 0.05 | 30,000 | 228² | 27,950 | 0.18s |
| **0.1** | **60,000** | **323²** | **17,068** | **0.29s** |
| 0.25 | 150,000 | 512² | 7,533 | 0.66s |
| 1.0 | 600,000 | 1024² | 1,785 | 2.80s |

`world_size` is the dominant lever and is set **once per run** — it is
disruptive, reallocating GPU buffers and restarting the simulation, so changing
it per candidate would cost more than the candidates.

**Rendering is not skipped, deliberately.** It was measured at 6–9% on top of
`advance()`, which is inside the noise: the simulation is GPU-bound in
`advance()` itself. A render-skipping path would have bought ~20ms on a ~300ms
candidate while costing the ability to watch a run.

At these speeds **the embedding dominates**, which is why generations are
batched: every capture in a generation is embedded in one call.

Observed on a real run: 19 candidates, 3 generations, **7.5 seconds** total.

---

## Configuration

`python -m pilot.run --write-example search.json` writes every knob with its
default. The ones that matter:

```json
{
  "run_dir": "documents/sequences/coral-hunt",
  "port": 8765,

  "world_size": 0.1,
  "cohorts": 1,
  "warmup_steps": 5000,
  "capture_size": 512,

  "mutation_scale": 0.35,

  "generations": 20,
  "beam_width": 8,
  "children_per_parent": 4,
  "immigrants": 4,
  "seed_configs": [],

  "backend": "texture",
  "reference_dir": "documents/references/coral",
  "aggregate": "mean",
  "grayscale": false,
  "seed": 0
}
```

For a **caption** objective instead of a reference folder:

```json
{
  "backend": "clip",
  "caption": "a dense tangled web of filaments",
  "negative_captions": ["an empty black image", "uniform random noise"],
  "calibrate": true,
  "grayscale": true,
  "crops": 8
}
```

or without touching the file:

```bash
python -m pilot.run --config search.json \
    --caption "a dense tangled web of filaments" \
    --negative "an empty black image"
```

`--caption` implies `backend: clip` and clears `reference_dir`.

| Knob | Notes |
|---|---|
| `world_size` | The throughput lever. Once per run. |
| `cohorts` | **Must be 1.** Validated — the move is undefined otherwise. |
| `warmup_steps` | Physics steps before capture. Linear in cost. |
| `capture_size` | The window is set to this, so captures are native rather than resampled. |
| `mutation_scale` | Step size. See the table above. |
| `beam_width` / `children_per_parent` | `K` survivors, `M` children each. |
| `immigrants` | Fresh random behaviours per generation. **Keep this nonzero.** |
| `seed_configs` | Start from configs you already like. Empty starts from immigrants. |
| `sample_size` | Random rules in generation 0 when there are no seeds. 0 = fill the beam. |
| `backend` | `texture` (scipy) or `clip` (torch). |
| `reference_dir` | Images to search toward. Omit for a scoreless smoke run. |
| `caption` | A text prompt to search toward. CLIP only; excludes `reference_dir`. |
| `negative_captions` | Things to search *away* from. Needs a caption. |
| `calibrate` | Background calibration for caption scoring. **Leave it on.** |
| `grayscale` | Desaturate before embedding. **See below** — CLIP only. |
| `seed` | Seeds the strategy RNG, so a run replays from `search.json`. |

### Two objectives

**Reference images** (`reference_dir`) — score by similarity to the centroid of
a folder of images you like. Works with either backend, needs no torch, and the
objective is inspectable by looking at the folder.

**A caption** (`caption`) — score by similarity to a text prompt. CLIP only.

They are mutually exclusive: with two objectives a result cannot be attributed
to either, so setting both is a config error.

### Why caption scoring calibrates, and why you should leave it on

Raw CLIP image-text cosines live in a **very narrow band**. Measured across 16
real captures against one caption: the whole range was **0.18 → 0.25**. Most of
that number describes the *caption* — its phrasing, its length, how typical it
is — rather than the image, so ranking on it is largely ranking the prompt
against itself.

`calibrate: true` (the default) scores each image against 30 generic background
captions as well, and reports how far the real caption stands out **per image**:

```
z = (score - median(background)) / (1.4826 * MAD(background))
```

Per-*image* is the part that matters. An image that scores highly against
everything — a busy frame — has a high median and gets no credit for it, while
one that matches your caption and nothing else scores a large z.

Measured effect on the same 16 captures:

| | raw cosine | calibrated |
|---|---|---|
| spread | 0.07 | **2.88** |

A 40× wider signal, and the rankings genuinely differ — only 3–5 of the top 5
survive the change, so it is not a monotonic rescale.

The background embeddings are computed **once** and reused, which makes `z` an
absolute quantity. That matters here in a way it does not for a one-shot CLI:
the beam holds survivors from any generation, so scores must be comparable
across them.

### Negative captions

```json
"negative_captions": ["an empty black image", "uniform random noise"]
```

The caption says what you want; negatives say what you keep getting instead.
Their similarity is subtracted (worst offender wins, so a candidate cannot hide
one strong match behind several weak ones), on the same calibrated scale as the
positive. This is the most direct lever for pushing a search out of a rut it
keeps rediscovering.

### Does CLIP understand these images? Partly.

Two observations from the same caption, *"a dense tangled web of filaments"*,
and they point in different directions.

**Ranking a fixed set: it did well.** Across 16 unrelated captures the top pick
was genuinely wispy and strand-like and the bottom was structureless noise.

**Driving a search: less convincing.** A 2-generation run climbed cleanly
(+3.92 → +4.84, and a mutant beat its parent) but converged on a dense speckled
*disc* — not a web of filaments. The search machinery did its job; the objective
led it somewhere the words do not describe.

That is the failure mode to expect: **a caption gives a signal strong enough to
climb, without necessarily meaning what you meant.** A search will find whatever
maximizes it, including degenerate answers.

Practical advice:

- **Run 2–3 generations and look before committing to a long run.** This is
  cheap — under a minute — and it is the only thing that tells you whether the
  prompt means what you think.
- **Use `grayscale: true`.** The run above was in colour and converged on a
  strongly blue result; palette is a shortcut a caption search will happily take.
- **Add negatives for what you keep getting.** Having seen the speckled disc,
  `"a dense field of small dots"` is the obvious thing to subtract.
- **If the prompt keeps missing, use a reference folder instead.** Images say
  what a sentence cannot, and the texture backend is more predictable on
  abstract pattern.

### Colour, and why you probably want it off

**Particle hue is driven by the same behaviour output that drives motion**, so
colour and shape are coupled at the source. In colour, a config that happens to
land on a palette near your references scores well *regardless of what it is
doing spatially* — which is how random noise of the right colour outranks a
genuinely interesting pattern, and the search then optimizes toward the palette
instead of the structure.

`"grayscale": true` desaturates every image before embedding — references and
candidates alike, which is the point: a query embedded in colour and a candidate
embedded in grey are not comparable quantities.

**This only affects `backend: "clip"`.** The texture backend already works from
luminance alone, so it is colour-blind whatever the flag says — one more reason
to try it first. The run prints which mode it is in:

```
scorer: reference-image (3 images, agg=mean, grayscale)
```

The standalone CLI has the same switch: `python demos/tex_sim.py rank imgs/
--backend clip --grayscale`.

Bad settings are caught **before** the app is touched: a missing
`reference_dir`, `cohorts != 1`, a search configured to produce nothing.

---

## Output

```
<run_dir>/
    search.json          the config actually used
    manifest.jsonl       one line per candidate, appended live
    report.txt           top 32 / bottom 32, written at the end
    configs/gen003_007.json
    captures/gen003_007.png
```

**Every candidate is kept, not just the winners**, so a finished run can be
re-scored against a different objective without re-running it. Each manifest
line carries the score, the lineage (`parent_id`, `mutation_scale`,
`mutation_seed`) and the full 80-float rule — enough to trace a surprising
result and reproduce it.

JSON Lines, flushed per candidate: a run killed at any moment keeps everything
up to that moment.

`documents/` is gitignored. Promote a config worth keeping into
`configs/custom/` and open it in the normal app.

### Reading a finished run

`report.txt` is written automatically at the end of every run: the objective
used, the run's shape, and the **top 32 and bottom 32** candidates with their
scores, lineage and capture paths.

To (re-)generate it for a run that has already finished — including one whose
terminal output is long gone:

```bash
python -m pilot.run --report documents/sequences/run
python -m pilot.run --config search.json --report      # uses the config's run_dir
```

No app, no simulation, no GPU — it reads the manifest. Useful options:

| | |
|---|---|
| `--top 64` | how many at each end |
| `--rescore` | re-embed the captures and score against the **current** config's objective, instead of the scores in the manifest |
| `--all` | include rows whose capture was overwritten (see below) |

`--rescore` is how you ask a finished run a different question — a new caption,
a different reference folder — without re-simulating anything. The captures are
already on disk; only the embedding is redone.

### Browsing a run as a map

```bash
python -m pilot.umap_view documents/sequences/run/captures --config search.json
```

Embeds every capture, projects them to 2D with UMAP, and plots them. Nearby
points look alike, so clusters are families of similar patterns — which is a
much faster way to find the interesting corner of a 4,000-candidate run than
scrolling a report.

- **Hover** a point for the capture, its score and its lineage.
- **Click** to load that candidate's config into a running Fluoddity. With no
  app running it copies the path instead — the viewer never requires one.
- **Drag** to pan, **scroll** to zoom (anchored on the cursor).
- **Colour by score** shades points blue → orange, so high-scoring regions are
  visible without hovering.
- **n_neighbors / min_dist / seed** re-project on the **Recompute** button, not
  on slider release: UMAP on a few thousand points takes ~25s and brushing a
  slider should not freeze the window. A `*` on the button means the plot is
  stale.

It runs in its own process and can sit open beside a search.

**Embeddings are cached** in `.umap_cache.npz` inside the folder, keyed by file
identity and by the backend signature. Measured on a 4,292-capture run: **98s**
the first time, **6s** to reopen. Changing the backend, `crops` or `grayscale`
correctly forces a re-embed rather than serving vectors that mean something
else.

It works on any folder of images, not just a run — point it at `refim/` or a
hand-assembled collection. A `manifest.jsonl` beside the folder just makes the
tooltips richer.

### Running twice into one folder

A second run into an occupied `run_dir` **tags its candidate ids** (`b01_`,
`b02_`, …) so it cannot overwrite the first. You will see:

```
8 candidate(s) already here; this session tags its ids 'b01_' so nothing
is overwritten (use --resume to continue the search instead)
```

Note the difference: a plain re-run starts a *new* search that happens to share
a folder, while `--resume` continues the existing one from its beam.

**Folders written before this existed can contain overwritten captures.** Ids
were `gen{generation}_{index}` only, so a repeated run reused them: both
manifest rows survive but only the later candidate's files do. `--report` says
so and ranks only the rows whose files are genuinely theirs; `--all` ranks
everything, with the caveat that some captures then show a different candidate
than the row describes. Every row still carries its full 80-float rule, so an
overwritten candidate can always be reconstructed.

### Resuming

```bash
python -m pilot.run --config search.json --resume
```

The beam is rebuilt from the manifest. App-side **checkpoints died with the
previous process**, so a resumed run reloads each survivor's saved config and
re-checkpoints it before breeding — which is why every candidate's config is
written to disk as it is made, not only the winners.

---

## Extending it

Two interfaces, both small on purpose.

**A scorer** turns a generation's embeddings into one number each:

```python
class Scorer(Protocol):
    def score(self, embeddings: np.ndarray) -> np.ndarray:   # (N,C,D) -> (N,)
```

`ReferenceImageScorer` and `PromptScorer` ship. `NoveltyScorer` is a stub whose
docstring records what building it involves.

**A strategy** decides what to try:

```python
class SearchStrategy(Protocol):
    def propose(self, generation: int) -> list[Move]: ...
    def observe(self, evaluated: list[Candidate]) -> None: ...
```

`BeamSearch` ships. The split is what keeps this open: novelty search and
quality-diversity produce candidates the same way and differ in what they
*keep*, which is `observe`. A strategy emits a `Move` — a request — and never
learns what performing one involves.

The archive holds every candidate ever evaluated. A `Candidate` is a couple of
kilobytes, so tens of thousands cost nothing, and it is what a later
novelty-style strategy would need.

---

## Before you trust a search

**Rank ~50 configs you already have, and look at the top and bottom ten.**

```bash
python demos/tex_sim.py similar --backend texture \
    --root configs/custom --query some_capture.png
```

If the ranking disagrees with your taste, fix the objective before building a
search on top of it. That costs an afternoon; discovering it after an overnight
run costs the night.

The scorer being *discriminating* is not the same as it being *right*: a smoke
run gave 19 distinct scores that visually separated structured patterns from
featureless blobs, which is encouraging and is not evidence that it tracks what
you actually want.

If the top candidates share a *palette* with your references but not a
structure, that is the colour coupling described above — set `grayscale: true`
(or switch to the texture backend) and run it again.

---

## Where the code is

```
pilot/client.py      typed wrapper over the HTTP API
pilot/candidate.py   Candidate and Move -- what the search passes around
pilot/config.py      SearchConfig
pilot/moves.py       THE move recipe, in one place
pilot/embedding.py   batched embedding (reuses demos/tex_sim.py)
pilot/scoring.py     Scorer interface + reference-image and prompt scorers
pilot/search.py      SearchStrategy interface + BeamSearch
pilot/run.py         the driver
pilot/report.py      manifest -> report.txt

pilot/gallery.py     a folder of images, embedded and cached
pilot/projection.py  embeddings -> 2D (UMAP)
pilot/umap_view.py   the viewer window
```

The last three are the map browser and are independent of the search: gallery
and projection are pure and testable without a window, and only `umap_view`
draws.

**`pilot/` imports nothing from the app.** They are one repository and two
processes; the HTTP API is the whole of the contact. That keeps torch away from
moderngl, and lets the pilot be restarted against a live simulation.

App-side, the search added three commands — `run_steps`, `fresh_candidate`,
`evaluate_candidate` — all in `orchestrator/api_commands.py`, all compositions
of handlers that already existed. They exist for **latency**, not capability:
one round trip per candidate instead of six.

## Testing

```
Scratch.venv/Scripts/python.exe tests/test_moves.py           # no GPU
Scratch.venv/Scripts/python.exe tests/test_search.py          # no GPU
Scratch.venv/Scripts/python.exe tests/test_gallery.py         # no GPU
Scratch.venv/Scripts/python.exe tests/test_pilot_loopback.py  # needs a display
```

`test_moves.py` asserts the four claims the search rests on, including the
zero-rule trap. `test_search.py` drives beam search against a synthetic
landscape with a known optimum. `test_pilot_loopback.py` runs a real two-
generation search against a real app and checks the things that only exist when
both processes are talking — siblings diverging from a restored parent
checkpoint, a torn manifest surviving, a resumed run still able to breed.
