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
  "seed": 0
}
```

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
| `backend` | `texture` (scipy) or `clip` (torch). |
| `reference_dir` | Images to search toward. Omit for a scoreless smoke run. |
| `seed` | Seeds the strategy RNG, so a run replays from `search.json`. |

Bad settings are caught **before** the app is touched: a missing
`reference_dir`, `cohorts != 1`, a search configured to produce nothing.

---

## Output

```
<run_dir>/
    search.json          the config actually used
    manifest.jsonl       one line per candidate, appended live
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

`ReferenceImageScorer` ships. `PromptScorer` and `NoveltyScorer` are stubs whose
docstrings record what building them involves — notably that **raw CLIP cosines
must be calibrated** against background captions (`tex_sim.py`'s `cmd_rank`
already does this; ranking by raw cosine mostly ranks the prompt against itself).

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

---

## Where the code is

```
pilot/client.py      typed wrapper over the HTTP API
pilot/candidate.py   Candidate and Move -- what the search passes around
pilot/config.py      SearchConfig
pilot/moves.py       THE move recipe, in one place
pilot/embedding.py   batched embedding (reuses demos/tex_sim.py)
pilot/scoring.py     Scorer interface + reference-image implementation
pilot/search.py      SearchStrategy interface + BeamSearch
pilot/run.py         the driver
```

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
Scratch.venv/Scripts/python.exe tests/test_pilot_loopback.py  # needs a display
```

`test_moves.py` asserts the four claims the search rests on, including the
zero-rule trap. `test_search.py` drives beam search against a synthetic
landscape with a known optimum. `test_pilot_loopback.py` runs a real two-
generation search against a real app and checks the things that only exist when
both processes are talking — siblings diverging from a restored parent
checkpoint, a torn manifest surviving, a resumed run still able to breed.
