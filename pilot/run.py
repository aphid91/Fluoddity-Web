"""The driver: a config in, a run folder out.

    Scratch.venv/Scripts/python.exe -m pilot.run --config search.json

THE LOOP

    for each generation:
        strategy proposes moves
        the app realizes each one and writes a capture       ~0.3s each
        every capture in the generation is embedded AT ONCE   the expensive bit
        the scorer turns embeddings into numbers
        the strategy folds the results back in
        the app sleeps while the next generation is planned

Generation-batched because the embedding dominates: at world_size 0.1 a
candidate is under a third of a second of simulation, so a per-candidate model
call would cost more than the thing it is measuring.

WHAT LANDS ON DISK

    <run_dir>/search.json          the config actually used
    <run_dir>/manifest.jsonl       one line per candidate, appended live
    <run_dir>/configs/<id>.json    every candidate, loadable in the real app
    <run_dir>/captures/<id>.png    what was embedded

Every candidate is kept, not just the winners. Re-scoring a finished run against
a different objective is then a matter of re-reading the folder, which is worth
far more than the disk it costs -- and the manifest carries each candidate's
lineage and rule, so a surprising result can be traced and reproduced.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import sys
import time
from pathlib import Path

from . import moves as move_lib
from . import scoring
from .candidate import IMMIGRANT, MUTANT, ROOT, Candidate
from .client import ApiError, FluoddityClient
from .config import SearchConfig
from .search import BeamSearch

#: Paths in a config are relative to the repo root, matching the app's own
#: convention -- a pilot launched from a different folder must not see a
#: different filesystem.
_REPO_ROOT = Path(__file__).resolve().parent.parent


def resolve(path):
    path = Path(path).expanduser()
    return path if path.is_absolute() else _REPO_ROOT / path


class RunFolder:
    """Where a run's output lives, and how a resumed run finds its place."""

    def __init__(self, root):
        self.root = Path(root)
        self.captures = self.root / 'captures'
        self.configs = self.root / 'configs'
        self.manifest = self.root / 'manifest.jsonl'

    def create(self):
        self.captures.mkdir(parents=True, exist_ok=True)
        self.configs.mkdir(parents=True, exist_ok=True)

    def append(self, candidate):
        """Add one manifest line, flushed immediately.

        JSON Lines rather than one JSON document, and flushed per candidate,
        so a run killed at any moment keeps everything up to that moment. A
        single document would have to be rewritten whole each time and would be
        truncated garbage if interrupted mid-write.
        """
        with self.manifest.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(candidate.to_row()) + '\n')
            handle.flush()

    def read(self):
        """Every candidate recorded so far. Tolerates a torn final line."""
        if not self.manifest.is_file():
            return []
        out = []
        for number, line in enumerate(
                self.manifest.read_text(encoding='utf-8').splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(Candidate.from_row(json.loads(line)))
            except (json.JSONDecodeError, KeyError) as e:
                # Only ever the last line, and only if the process died
                # mid-write. Warn and keep the rest rather than refusing to
                # resume over one bad row.
                print(f"  manifest line {number} unreadable ({e}); skipping")
        return out


class SearchRun:
    """One search, start to finish."""

    def __init__(self, cfg, client=None, strategy=None, scorer=None,
                 backend=None):
        self.cfg = cfg
        self.folder = RunFolder(resolve(cfg.run_dir))
        self.client = client or FluoddityClient(port=cfg.port)

        # Injectable so the loopback test can drive the whole loop with a
        # trivial scorer and no embedding backend at all.
        self.backend = backend
        self.scorer = scorer
        self.strategy = strategy or BeamSearch(
            cfg, seed_configs=[resolve(p) for p in cfg.seed_configs])

        self.start_generation = 0
        self._counter = 0
        #: Beam entries read from a resumed manifest, awaiting app-side
        #: checkpoints. Empty for a fresh run.
        self._pending_restore = None

    # ------------------------------------------------------------------

    def prepare(self):
        problems = list(self.cfg.validate())
        # Only when a backend will actually be built: a smoke run with an
        # injected scorer needs neither scipy nor torch.
        if self.scorer is None:
            from . import embedding
            problems.extend(embedding.check_dependencies(self.cfg.backend))
        if problems:
            for problem in problems:
                print(f"  config error: {problem}")
            raise SystemExit(1)

        self.folder.create()
        self.cfg.save(self.folder.root / 'search.json')

        if self.cfg.resume:
            self._resume()

        if self.scorer is None:
            # Built AFTER validation and BEFORE the app is touched: loading a
            # CLIP model can take a while and can fail, and discovering that
            # after a generation of simulation would waste the simulation.
            from . import embedding
            self.backend = self.backend or embedding.build_backend(self.cfg)
            self.scorer = scoring.build_scorer(self.cfg, self.backend)
        print(f"  scorer: {self.scorer.describe()}")

        if not self.client.wait_until_up():
            raise SystemExit(
                f"no Fluoddity on port {self.cfg.port}. Start one with:\n"
                f"  python main.py --api-port {self.cfg.port}")

        size = move_lib.prepare_session(self.client, self.cfg)
        state = self.client.state()
        print(f"  app ready: {state['entity_count']} entities, "
              f"canvas {state['canvas_size']}, framebuffer {list(size)}")

        # After the session is prepared: reloading a config needs the world
        # size already settled, or every restored candidate would be
        # checkpointed against a system about to be rebuilt.
        self._reestablish_checkpoints()

    def _resume(self):
        """Pick up where a previous process stopped.

        The beam is rebuilt from the manifest, but the app-side CHECKPOINTS are
        gone -- they lived in the previous app session. Rather than pretend
        otherwise, a resumed run re-establishes them by re-evaluating each
        survivor from its saved config file. That costs one generation's worth
        of simulation and makes the alternative -- silently breeding from
        whatever the app happens to have loaded -- impossible.
        """
        previous = self.folder.read()
        if not previous:
            print("  resume: nothing recorded yet, starting fresh")
            return
        self._pending_restore = self.strategy.restore(previous)
        self.start_generation = max(c.generation for c in previous) + 1
        self._counter = len(previous)
        print(f"  resume: {len(previous)} candidates, "
              f"continuing at generation {self.start_generation}")
        print(f"  resume: {self.strategy.summary()}")

    def _reestablish_checkpoints(self):
        """Re-create the app-side checkpoints a resumed beam needs.

        Checkpoints are in-session: they died with the previous process. The
        beam survived in the manifest, but next generation's children have to
        be grown FROM something, so each survivor's saved config is reloaded
        and re-checkpointed.

        This is why every candidate's config is written to disk as it is made,
        not only the winners -- without that file there would be nothing to
        restore from and a resumed run could only start over.
        """
        pending = getattr(self, '_pending_restore', None)
        if not pending:
            return
        print(f"  resume: re-establishing {len(pending)} checkpoint(s)")
        restored = []
        for candidate in pending:
            if not candidate.config_path:
                print(f"    {candidate.id}: no saved config, dropped")
                continue
            try:
                self.client.load_config(candidate.config_path)
                self.client.set_config(cohorts=self.cfg.cohorts,
                                       mutation_scale=0.0)
                move_lib.checkpoint(self.client, candidate)
                restored.append(candidate)
            except ApiError as e:
                print(f"    {candidate.id}: {e}")
        # The beam can only contain what the app can actually breed from.
        self.strategy.beam = restored
        self._pending_restore = None

    def _next_id(self, generation, index):
        self._counter += 1
        return f"gen{generation:03d}_{index:03d}"

    # ------------------------------------------------------------------

    def realize(self, move, generation, index):
        """Perform one move and capture the result.

        Returns an unscored Candidate, or None if the app refused. A refusal is
        survivable -- one bad candidate should not end a run that may have
        hours of work in it -- so it is logged and the generation continues.
        """
        candidate_id = self._next_id(generation, index)
        capture = self.folder.captures / f"{candidate_id}.png"

        try:
            if move.origin == ROOT:
                candidate = move_lib.make_root(
                    self.client, self.cfg, candidate_id, generation,
                    move.config_path, capture)
            elif move.origin == IMMIGRANT:
                candidate = move_lib.make_immigrant(
                    self.client, self.cfg, candidate_id, generation, capture)
            elif move.origin == MUTANT:
                parent = self._by_id(move.parent_id)
                if parent is None:
                    print(f"    {candidate_id}: parent {move.parent_id} gone")
                    return None
                candidate = move_lib.make_mutant(
                    self.client, self.cfg, candidate_id, generation, parent,
                    capture, scale=move.mutation_scale,
                    seed=move.mutation_seed)
            else:
                print(f"    {candidate_id}: unknown origin {move.origin!r}")
                return None
        except ApiError as e:
            print(f"    {candidate_id}: {e}")
            return None

        # Saved BEFORE scoring: a config on disk is the durable artifact, and a
        # run that dies during embedding should still leave loadable results.
        config_path = self.folder.configs / f"{candidate_id}.json"
        try:
            self.client.save_config(config_path)
            candidate = dataclasses.replace(candidate,
                                            config_path=str(config_path))
        except ApiError as e:
            print(f"    {candidate_id}: config not saved ({e})")

        # The checkpoint is what makes this candidate breedable next
        # generation. Released later if it does not survive the cull.
        move_lib.checkpoint(self.client, candidate)
        return candidate

    def _by_id(self, candidate_id):
        for candidate in self.strategy.beam:
            if candidate.id == candidate_id:
                return candidate
        return None

    def score_generation(self, candidates):
        """Embed every capture at once, then score.

        The batching that the whole generational structure exists for.
        """
        if not candidates:
            return []
        from . import embedding

        paths = [c.capture_path for c in candidates]
        embeddings = embedding.embed_paths(self.backend, paths) \
            if self.backend is not None else None
        if embeddings is None:
            # No backend: a smoke run. The scorer is expected to ignore its
            # argument (see ConstantScorer).
            import numpy as np
            embeddings = np.zeros((len(candidates), 1, 1), dtype=np.float32)

        scores = self.scorer.score(embeddings)
        return [c.scored(float(s)) for c, s in zip(candidates, scores)]

    def run_generation(self, generation):
        started = time.monotonic()
        moves = self.strategy.propose(generation)
        print(f"\ngeneration {generation}: {len(moves)} candidates")

        evaluated = []
        for index, move in enumerate(moves):
            candidate = self.realize(move, generation, index)
            if candidate is not None:
                evaluated.append(candidate)
        simulated = time.monotonic() - started

        scored = self.score_generation(evaluated)
        for candidate in scored:
            self.folder.append(candidate)

        self.strategy.observe(scored)
        # Free the app's memory for everything that did not survive. Without
        # this a long run accumulates a whole Project per candidate, forever.
        move_lib.release_checkpoints(self.client,
                                     self.strategy.culled(scored))

        elapsed = time.monotonic() - started
        print(f"  {len(scored)}/{len(moves)} evaluated in {elapsed:.1f}s "
              f"(sim {simulated:.1f}s, embed+score {elapsed - simulated:.1f}s)")
        print(f"  {self.strategy.summary()}")
        if self.strategy.best is not None:
            print(f"  best so far: {self.strategy.best.id} "
                  f"({self.strategy.best.score:+.4f})")

    def run(self):
        self.prepare()
        last = self.start_generation + self.cfg.generations
        try:
            for generation in range(self.start_generation, last):
                self.run_generation(generation)
                # Park between generations. The pilot is about to do its own
                # work, and a rendering app is competing for the same GPU.
                if generation + 1 < last:
                    self.client.sleep(timeout=600)
        except KeyboardInterrupt:
            print("\ninterrupted -- the manifest holds everything completed")
        finally:
            try:
                self.client.wake()
            except (ApiError, OSError):
                pass

        self.report()

    def report(self):
        best = self.strategy.best
        print(f"\nrun complete: {self.folder.root}")
        print(f"  {len(self.strategy.archive)} candidates evaluated")
        if best is not None:
            print(f"  best: {best.id}  score {best.score:+.4f}")
            print(f"        {best.config_path}")
            print(f"        {best.capture_path}")
        print(f"\n  top {min(10, len(self.strategy.beam))}:")
        for candidate in self.strategy.beam[:10]:
            print(f"    {candidate.score:+.4f}  {candidate.id:<14}"
                  f"{candidate.origin:<10} {candidate.capture_path}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="CLIP-guided search over Fluoddity's mutation space")
    parser.add_argument('--config', help="a search config JSON (see docs/SEARCH.md)")
    parser.add_argument('--run-dir', help="override the config's run_dir")
    parser.add_argument('--port', type=int, help="override the config's port")
    parser.add_argument('--generations', type=int, help="override generations")
    parser.add_argument('--resume', action='store_true',
                        help="continue an existing run_dir")
    parser.add_argument('--write-example', metavar='PATH',
                        help="write a commented example config and exit")
    args = parser.parse_args(argv)

    if args.write_example:
        cfg = SearchConfig()
        path = cfg.save(args.write_example)
        print(f"wrote {path}")
        print("edit reference_dir to point at images you want to search toward")
        return 0

    cfg = SearchConfig.load(args.config) if args.config else SearchConfig()
    overrides = {}
    if args.run_dir:
        overrides['run_dir'] = args.run_dir
    if args.port:
        overrides['port'] = args.port
    if args.generations:
        overrides['generations'] = args.generations
    if args.resume:
        overrides['resume'] = True
    if overrides:
        cfg = dataclasses.replace(cfg, **overrides)

    print(f"search: {cfg.generations} generations x "
          f"{cfg.candidates_per_generation} candidates "
          f"(~{cfg.warmup_steps} steps each)")
    SearchRun(cfg).run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
