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

from . import embedding_cache
from . import moves as move_lib
from . import report as report_lib
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


#: Re-exported: it lives in config.py, beside the field it expands.
expand_seed_configs = SearchConfig.expand_seed_configs


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

    @property
    def report(self):
        return self.root / 'report.txt'

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
                 backend=None, progress=None):
        self.cfg = cfg
        #: Where status goes. `print` on the command line; a Task's reporter
        #: when the GUI is driving, which is what feeds the progress bar.
        self.progress = progress if progress is not None else print
        self.folder = RunFolder(resolve(cfg.run_dir))
        self.client = client or FluoddityClient(port=cfg.port)

        # Injectable so the loopback test can drive the whole loop with a
        # trivial scorer and no embedding backend at all.
        self.backend = backend
        self.scorer = scorer
        self.strategy = strategy or BeamSearch(
            cfg, seed_configs=expand_seed_configs(cfg.seed_configs))

        self.start_generation = 0
        self._counter = 0
        #: Beam entries read from a resumed manifest, awaiting app-side
        #: checkpoints. Empty for a fresh run.
        self._pending_restore = None
        #: Shared with the viewer; opened lazily so a smoke run with no
        #: backend never touches the disk.
        self._embedding_cache = None
        #: Prefix making this session's ids distinct from any already in the
        #: folder. Empty for the first session, so a single-run folder keeps
        #: the plain "gen000_000" names. Set in prepare().
        self._session = ''

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

        existing = self.folder.read() if self.folder.manifest.is_file() else []
        if existing and not self.cfg.resume:
            # A second run into an occupied folder. Allowed -- it is a
            # reasonable thing to want -- but it must not pretend to be the
            # first: without a distinct session tag it would reuse ids and
            # overwrite the earlier run's captures and configs.
            self._session = self._session_tag(existing)
            print(f"  {len(existing)} candidate(s) already here; this session "
                  f"tags its ids '{self._session}' so nothing is overwritten "
                  f"(use --resume to continue the search instead)")

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

    @staticmethod
    def _session_tag(existing):
        """The next free 'bNN_' prefix, given what is already in the folder.

        Scans the ids present rather than counting sessions, so it stays
        correct even if a folder was assembled by hand or an earlier session
        was partly deleted.
        """
        used = set()
        for candidate in existing:
            head, _, _ = candidate.id.partition('gen')
            used.add(head)
        for n in range(1, 1000):
            tag = f"b{n:02d}_"
            if tag not in used:
                return tag
        raise RuntimeError("too many sessions in one run folder")

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
        # A resumed session continues the generation count, but its RNG starts
        # over from cfg.seed -- so it will redraw the same mutation seeds and,
        # without a distinct tag, the same ids. Tag it for the same reason a
        # repeated run is tagged.
        self._session = self._session_tag(previous)
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
                # Same lock-in as make_root: a config written by this run has
                # mutation_scale 0 already, but one hand-edited between
                # sessions may not, and re-establishing a beam member as
                # something other than what it scored as would corrupt the
                # search silently.
                self.client.set_config(cohorts=self.cfg.cohorts)
                self.client.cmd('select_particle_at', index=0)
                self.client.set_config(mutation_scale=0.0)
                move_lib.checkpoint(self.client, candidate)
                restored.append(candidate)
            except ApiError as e:
                print(f"    {candidate.id}: {e}")
        # The beam can only contain what the app can actually breed from.
        self.strategy.beam = restored
        self._pending_restore = None

    def _next_id(self, generation, index):
        """A candidate id unique within the run folder, across sessions.

        THE SESSION TAG IS LOAD-BEARING. Ids were once just
        "gen{generation}_{index}", which collides the moment a second run
        writes into the same folder: generation numbering restarts at 0, the
        strategy's RNG restarts from the same seed, and the new session
        produces the same ids for entirely different candidates -- silently
        overwriting the previous session's configs and captures while both sets
        of manifest rows survive. A real run lost the captures for its 100
        best candidates that way, and nothing reported it.

        `_session` is derived from what is already in the folder, so a resumed
        or repeated run always tags itself differently from what came before.
        """
        self._counter += 1
        return f"{self._session}gen{generation:03d}_{index:03d}"

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
        #
        # Skipped entirely for a sampling run: nothing will ever breed from
        # these, and a run drawing a few thousand rules would otherwise
        # accumulate a whole Project per candidate in the app for no reason.
        if not self.cfg.is_sampling_run:
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

        WRITES THROUGH THE SHARED CACHE, so the UMAP viewer never re-embeds
        what a search has already done. Same files, same model, same settings
        -- paying for that twice was ninety seconds of pure waste every time a
        finished run was opened.
        """
        if not candidates:
            return []
        import numpy as np

        if self.backend is None:
            # No backend: a smoke run. The scorer is expected to ignore its
            # argument (see ConstantScorer).
            embeddings = np.zeros((len(candidates), 1, 1), dtype=np.float32)
        else:
            embeddings = embedding_cache.embed_cached(
                [c.capture_path for c in candidates], self.backend,
                self._cache(), progress=self.progress)

        scores = self.scorer.score(embeddings)
        return [c.scored(float(s)) for c, s in zip(candidates, scores)]

    def _cache(self):
        """The capture folder's embedding cache, opened once per run."""
        if self._embedding_cache is None:
            self._embedding_cache = embedding_cache.EmbeddingCache(
                self.folder.captures)
        return self._embedding_cache

    def run_generation(self, generation):
        started = time.monotonic()
        moves = self.strategy.propose(generation)
        self.progress(f"\ngeneration {generation}: {len(moves)} candidates")
        step = getattr(self.progress, 'step', None)

        evaluated = []
        for index, move in enumerate(moves):
            candidate = self.realize(move, generation, index)
            if candidate is not None:
                evaluated.append(candidate)
            # Per candidate, because a sampling generation IS the whole run --
            # 5,000 of them, so per-generation progress would be a bar that
            # sits at zero for twenty minutes and then finishes.
            if step is not None:
                step(index + 1, len(moves), 'candidates',
                     label=f"generation {generation}")
        simulated = time.monotonic() - started

        if step is not None:
            step(0, 0)          # indeterminate: embedding does not tick here
        scored = self.score_generation(evaluated)
        for candidate in scored:
            self.folder.append(candidate)

        self.strategy.observe(scored)
        # Free the app's memory for everything that did not survive. Without
        # this a long run accumulates a whole Project per candidate, forever.
        move_lib.release_checkpoints(self.client,
                                     self.strategy.culled(scored))

        elapsed = time.monotonic() - started
        self.progress(
            f"  {len(scored)}/{len(moves)} evaluated in {elapsed:.1f}s "
            f"(sim {simulated:.1f}s, embed+score {elapsed - simulated:.1f}s)")
        self.progress(f"  {self.strategy.summary()}")
        if self.strategy.best is not None:
            self.progress(f"  best so far: {self.strategy.best.id} "
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
        """Summarize, and WRITE THE SUMMARY TO DISK.

        Reading everything back from the manifest rather than from
        strategy.archive, so the report covers the whole folder -- including
        earlier sessions -- and so it is the same code path the standalone
        --report mode uses.
        """
        best = self.strategy.best
        print(f"\nrun complete: {self.folder.root}")
        print(f"  {len(self.strategy.archive)} candidates evaluated this session")
        if best is not None:
            print(f"  best: {best.id}  score {best.score:+.4f}")
            print(f"        {best.config_path}")
            print(f"        {best.capture_path}")

        path = write_report(self.folder, self.cfg)
        if path is not None:
            print(f"\n  wrote {path}")

        print(f"\n  top {min(10, len(self.strategy.beam))} this session:")
        for candidate in self.strategy.beam[:10]:
            print(f"    {candidate.score:+.4f}  {candidate.id:<20}"
                  f"{candidate.origin:<10} {candidate.capture_path}")


def write_report(folder, cfg=None, count=report_lib.DEFAULT_COUNT):
    """Write report.txt for a run folder. None if there is nothing to report."""
    candidates = folder.read()
    if not candidates:
        return None
    kept, shadowed = report_lib.dedupe(candidates)
    title = f"Fluoddity search results -- {folder.root.name}"
    if shadowed:
        # Only possible in folders written before session tagging. Say so in
        # the report rather than quietly ranking rows whose pictures are gone.
        title += (f"\n\nNOTE: {shadowed} manifest row(s) share an id with a "
                  f"later candidate and were overwritten on disk; only the "
                  f"surviving {len(kept)} are ranked here. See "
                  f"'--report --all' to rank every row.")
    return report_lib.write(folder.report, kept, cfg=cfg, count=count,
                            root=folder.root, title=title)


def _report(args):
    """Rank a finished run. No app, no simulation -- just the manifest.

    Exists because a run's results used to live only in terminal scrollback:
    an overnight search that completed successfully was unreadable the moment
    the window closed. Everything needed was always on disk.
    """
    cfg = SearchConfig.load(args.config) if args.config else None
    run_dir = args.report or (cfg.run_dir if cfg else None)
    if not run_dir:
        print("--report needs a run directory, or a --config naming one")
        return 1

    folder = RunFolder(resolve(run_dir))
    if not folder.manifest.is_file():
        print(f"no manifest at {folder.manifest}")
        return 1

    candidates = folder.read()
    print(f"{len(candidates)} manifest row(s) in {folder.root}")

    kept, shadowed = report_lib.dedupe(candidates)
    if args.all:
        kept = candidates
        if shadowed:
            print(f"  ranking all rows; {shadowed} of them have a capture on "
                  f"disk that belongs to a different candidate")
    elif shadowed:
        print(f"  {shadowed} row(s) were overwritten by a later session "
              f"sharing their id; ranking the {len(kept)} whose files survive "
              f"(--all to include them)")

    if args.rescore:
        if cfg is None:
            print("--rescore needs a --config to score against")
            return 1
        kept = _rescore(kept, cfg, folder)

    path = report_lib.write(
        folder.report, kept, cfg=cfg, count=args.top, root=folder.root,
        title=f"Fluoddity search results -- {folder.root.name}")
    print(f"wrote {path}\n")

    # Also to stdout, so the common case needs no second command.
    for line in report_lib.build(kept, cfg=cfg, count=min(args.top, 32),
                                 root=folder.root):
        print(line)
    return 0


def _rescore(candidates, cfg, folder, progress=print):
    """Re-score each capture against `cfg`'s objective. Returns new Candidates.

    For asking a finished run a different question -- a new caption, or a
    different reference folder -- without re-simulating anything. The captures
    are on disk and their embeddings are cached, so only the text side is new.

    DOES NOT TOUCH manifest.jsonl. Those scores are the ones that actually
    drove selection, and they are the only account of why the beam kept what
    it kept; overwriting them with a hypothetical would destroy the run's
    provenance. The new scores go to report.txt and to whoever asked.
    """
    from . import embedding

    # WITH the model, not just the backend. SO400M needs transformers for its
    # tokenizer, and checking the backend alone let that surface minutes later
    # as an ImportError from inside open_clip, after the weights had loaded.
    problems = embedding.check_dependencies(cfg.backend, cfg.clip_model)
    if problems:
        for problem in problems:
            progress(f"  {problem}")
        raise SystemExit(1)

    usable = [c for c in candidates
              if c.capture_path and Path(c.capture_path).is_file()]
    missing = len(candidates) - len(usable)
    if missing:
        progress(f"  {missing} candidate(s) have no capture on disk; skipped")
    if not usable:
        progress("  nothing to re-score")
        return candidates

    backend = embedding.build_backend(cfg)
    scorer = scoring.build_scorer(cfg, backend)
    progress(f"  re-scoring {len(usable)} capture(s): {scorer.describe()}")

    # Through the shared cache: a re-score against a new caption is exactly
    # the case where the captures were embedded minutes ago and nothing about
    # them has changed. Only the text side is new.
    cache = embedding_cache.EmbeddingCache(folder.captures)
    vectors = embedding_cache.embed_cached(
        [c.capture_path for c in usable], backend, cache, progress=progress)
    return [c.scored(float(s))
            for c, s in zip(usable, scorer.score(vectors))]


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="CLIP-guided search over Fluoddity's mutation space")
    parser.add_argument('--config', help="a search config JSON (see docs/SEARCH.md)")
    parser.add_argument('--run-dir', help="override the config's run_dir")
    parser.add_argument('--port', type=int, help="override the config's port")
    parser.add_argument('--generations', type=int, help="override generations")
    parser.add_argument('--resume', action='store_true',
                        help="continue an existing run_dir")
    parser.add_argument('--caption', action='append', metavar='TEXT',
                        help="search toward a text prompt (implies "
                             "backend=clip; overrides reference_dir). "
                             "Repeatable for several phrasings.")
    parser.add_argument('--negative', action='append', metavar='TEXT',
                        default=None,
                        help="search AWAY from this; repeatable")
    parser.add_argument('--write-example', metavar='PATH',
                        help="write a commented example config and exit")
    parser.add_argument('--report', metavar='RUN_DIR', nargs='?',
                        const='', default=None,
                        help="rank a FINISHED run and write report.txt, "
                             "without touching the app. Defaults to the "
                             "config's run_dir.")
    parser.add_argument('--rescore', action='store_true',
                        help="--report: re-embed the captures and score them "
                             "against the CURRENT config's objective, instead "
                             "of using the scores in the manifest")
    parser.add_argument('--top', type=int, default=report_lib.DEFAULT_COUNT,
                        help="--report: how many at each end (default 32)")
    parser.add_argument('--all', action='store_true',
                        help="--report: rank every manifest row, including "
                             "ones whose capture was overwritten by a later "
                             "session")
    args = parser.parse_args(argv)

    if args.report is not None:
        return _report(args)

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
    if args.caption:
        # A caption on the command line means a caption run: switch the backend
        # and drop any reference folder, rather than failing validation over a
        # combination the user plainly did not intend. Repeatable, so several
        # phrasings can be given without editing the config.
        overrides['captions'] = list(args.caption)
        overrides['backend'] = 'clip'
        overrides['reference_dir'] = ''
    if args.negative:
        overrides['negative_captions'] = list(args.negative)
    if overrides:
        cfg = dataclasses.replace(cfg, **overrides)

    print(f"search: {cfg.describe_plan()} (~{cfg.warmup_steps} steps each)")
    SearchRun(cfg).run()
    return 0


if __name__ == '__main__':
    sys.exit(main())
