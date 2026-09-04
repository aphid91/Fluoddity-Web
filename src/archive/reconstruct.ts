/**
 * Turning an archive back into project states.
 *
 * The inverse of `delta.ts`, and the reason the archive stores deltas at all: a
 * node plus its lineage plus a root is enough to rebuild the exact `Project` the
 * user was looking at. This is the component every later analysis is built on --
 * "what did state X actually contain" is the question the dataset exists to
 * answer, and it is answered here.
 *
 * ## THE INTERFACE
 *
 * `loadArchive(doc)` parses and indexes an exported document once.
 * `reconstruct(archive, hash)` walks that node's lineage to its root and replays
 * forward, returning a `Project`. Everything else is convenience over those two.
 *
 * Indexing up front rather than scanning per query is what makes bulk work
 * viable: reconstructing every node in a 100k-node archive is O(n) walks over an
 * O(1) map rather than 100k linear searches.
 *
 * ## PURE, AND DELIBERATELY SO
 *
 * No DOM, no IndexedDB, no GPU. It takes a parsed document and returns values,
 * which is what lets it run under `node --test`, inside the app, or in a batch
 * script over a directory of exports. `persistence.ts` and `shareLink.ts` make
 * the same choice for the same reason.
 *
 * ## THE ONE THING IT CANNOT DO ALONE
 *
 * A `selection` delta stores a COHORT NUMBER, not the eighty floats it produced.
 * Recovering the rule means running `derive_entity_rule` -- and `rule.wgsl`'s
 * header is emphatic that reimplementing that function in another language is a
 * mistake this port already made once and deleted: `pow(h, 2.0)` versus `h*h`
 * differs by 1 ULP, the chaotic hash amplifies it into a completely different
 * rule, and the generator leans on a fused multiply-add the GPU performs and a
 * host generally will not. A wrong rule looks entirely legitimate.
 *
 * So this module does NOT guess. `RuleDeriver` is the seam: supply one that runs
 * the real shader (the export ships `rule.wgsl` for exactly this) and selection
 * nodes reconstruct exactly. Supply none and they are reported as
 * `needsDeriver` rather than silently approximated -- which is the whole point,
 * because an approximated rule is indistinguishable from a correct one by
 * inspection.
 *
 * **THE SAME APPLIES TO `randomize`.** It stores the seed and sets the rule to
 * the ZERO SENTINEL, which is not a rule but the "no target given" signal that
 * makes the shader generate one. Reconstructing the PROJECT needs no deriver --
 * the project genuinely holds zeros, and that is what a save file would contain
 * -- so those nodes reconstruct fine. Only asking "what were the particles
 * actually obeying" needs the generator, and that is a different question from
 * "what was the project state".
 */

import {
  type SimulationConfig,
  type WorldSettings,
  makeSimulationConfig,
} from '../particleSystem/config.ts';
import { type Project, makeProject } from '../project/project.ts';
import type { Delta } from './delta.ts';
import type { VisitRecord } from './visits.ts';
import type { ArchiveNode, ArchiveRoot } from './archiveDb.ts';

/**
 * Derives the rule a picked particle was obeying.
 *
 * The signature mirrors `derive_entity_rule(rule_in, cohort, config)` exactly,
 * because the only correct implementation IS that function -- run through a real
 * WGSL pipeline, over the `rule.wgsl` the export carries. Anything else is an
 * approximation, and this type exists so that choice is made explicitly by a
 * caller rather than implicitly by this module.
 *
 * `mutationSeed` and `mutationScale` come from the PARENT config, and the rule
 * seed the shader uses is `mutationSeed + floor(cohort)`.
 */
export type RuleDeriver = (input: {
  readonly rule: readonly number[];
  readonly cohort: number;
  readonly mutationSeed: number;
  readonly mutationScale: number;
}) => readonly number[];

/** Thrown for a document this module will not read. */
export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/** An exported archive, indexed for lookup. */
export interface Archive {
  readonly nodes: ReadonlyMap<string, ArchiveNode>;
  readonly roots: ReadonlyMap<string, ArchiveRoot>;
  /** Insertion order as exported, which is first-visit order within a session. */
  readonly order: readonly string[];
  /**
   * The path walked, in order -- the dataset `order` cannot give you.
   *
   * `order` is DISCOVERY order and holds each state once; this is TRAVERSAL
   * order and holds every arrival, including the revisits, undos and redos that
   * the node tree does not record. Empty for a document exported before the log
   * existed, which is why nothing here may assume it is populated. See
   * `visits.ts`.
   */
  readonly visits: readonly VisitRecord[];
  /** The derivation sources the export shipped, for a deriver to compile. */
  readonly derivation: {
    readonly hash: string;
    readonly ruleSource: string;
    readonly commonSource: string;
  } | null;
}

/**
 * Index an exported archive document.
 *
 * Tolerant about EXTRA fields and strict about missing ones: a document written
 * by a later build should still load here, but a node without a hash is not a
 * node and quietly skipping it would give a lineage walk a dangling parent to
 * fail on much later, with no clue where the damage came from.
 */
export function loadArchive(doc: unknown): Archive {
  if (typeof doc !== 'object' || doc === null) {
    throw new ArchiveFormatError('archive is not an object');
  }
  const raw = doc as Record<string, unknown>;
  const rawNodes = raw['nodes'];
  const rawRoots = raw['roots'];
  if (!Array.isArray(rawNodes)) throw new ArchiveFormatError('archive has no "nodes" array');
  if (!Array.isArray(rawRoots)) throw new ArchiveFormatError('archive has no "roots" array');

  const nodes = new Map<string, ArchiveNode>();
  const order: string[] = [];
  for (const entry of rawNodes as ArchiveNode[]) {
    if (typeof entry?.hash !== 'string') {
      throw new ArchiveFormatError('a node is missing its "hash"');
    }
    nodes.set(entry.hash, entry);
    order.push(entry.hash);
  }

  const roots = new Map<string, ArchiveRoot>();
  for (const entry of rawRoots as ArchiveRoot[]) {
    if (typeof entry?.hash !== 'string') {
      throw new ArchiveFormatError('a root is missing its "hash"');
    }
    roots.set(entry.hash, entry);
  }

  // TOLERATED WHEN ABSENT, unlike `nodes` and `roots` above. A document exported
  // before the visit log existed is still a complete node tree and should read
  // rather than throw; an empty log is the truthful answer for one, since the
  // path through those states genuinely was not recorded. Only a `visits` that
  // is present and malformed is worth rejecting, and `Array.isArray` covers it.
  const rawVisits = raw['visits'];
  const visits: readonly VisitRecord[] = Array.isArray(rawVisits)
    ? (rawVisits as VisitRecord[])
    : [];

  const d = raw['derivation'] as Record<string, unknown> | undefined;
  const derivation =
    d !== undefined && typeof d['hash'] === 'string'
      ? {
          hash: d['hash'],
          ruleSource: String(d['rule.wgsl'] ?? ''),
          commonSource: String(d['common.wgsl'] ?? ''),
        }
      : null;

  return { nodes, roots, order, visits, derivation };
}

/** Why a reconstruction could not be completed. */
export type ReconstructFailure =
  /** No node with that hash. */
  | { readonly kind: 'unknownNode'; readonly hash: string }
  /** The lineage walked off the end without reaching a stored root. */
  | { readonly kind: 'missingRoot'; readonly hash: string }
  /** A parent hash that is not in the archive -- a truncated or edited export. */
  | { readonly kind: 'brokenLineage'; readonly hash: string; readonly parent: string }
  /** A `selection` delta was reached and no `RuleDeriver` was supplied. */
  | { readonly kind: 'needsDeriver'; readonly hash: string; readonly cohort: number }
  /** A delta names a config slot the state does not have. */
  | { readonly kind: 'badDelta'; readonly hash: string; readonly detail: string };

export type ReconstructResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly failure: ReconstructFailure };

/**
 * The chain from a root down to `hash`, oldest first.
 *
 * Separate from `reconstruct` because it answers a question worth asking on its
 * own -- "how did I get here" is half of what the archive is FOR -- and because
 * it is the natural place for lineage damage to be reported, before any replay
 * has happened.
 */
export function lineageOf(
  archive: Archive,
  hash: string,
): { readonly ok: true; readonly chain: readonly ArchiveNode[] } |
   { readonly ok: false; readonly failure: ReconstructFailure } {
  const chain: ArchiveNode[] = [];
  // A cycle cannot occur in a first-visit graph -- a node's parent is always
  // strictly older -- but a hand-edited export is still an input, and an
  // unbounded walk over one would hang rather than report.
  const seen = new Set<string>();
  let cursor: string | null = hash;

  while (cursor !== null) {
    if (seen.has(cursor)) {
      return { ok: false, failure: { kind: 'brokenLineage', hash, parent: cursor } };
    }
    seen.add(cursor);
    const node: ArchiveNode | undefined = archive.nodes.get(cursor);
    if (node === undefined) {
      return cursor === hash
        ? { ok: false, failure: { kind: 'unknownNode', hash } }
        : { ok: false, failure: { kind: 'brokenLineage', hash, parent: cursor } };
    }
    chain.push(node);
    cursor = node.parent;
  }

  chain.reverse();
  return { ok: true, chain };
}

/** Apply one delta to a state, returning the next. */
function applyDelta(
  configs: SimulationConfig[],
  world: WorldSettings,
  delta: Delta,
  hash: string,
  deriver: RuleDeriver | null,
): { world: WorldSettings } | ReconstructFailure {
  switch (delta.kind) {
    case 'full':
      // Self-contained: replaces everything, so nothing before it matters.
      configs.length = 0;
      configs.push(...delta.configs.map((c) => ({ ...c, rule: c.rule.slice() })));
      return { world: delta.world };

    case 'worldField':
      return { world: { ...world, [delta.field]: delta.value } as WorldSettings };

    case 'configField': {
      const target = configs[delta.config];
      if (target === undefined) {
        return { kind: 'badDelta', hash, detail: `config ${delta.config} does not exist` };
      }
      configs[delta.config] = { ...target, [delta.field]: delta.value };
      return { world };
    }

    case 'rule': {
      const target = configs[delta.config];
      if (target === undefined) {
        return { kind: 'badDelta', hash, detail: `config ${delta.config} does not exist` };
      }
      configs[delta.config] = { ...target, rule: delta.rule.slice() };
      return { world };
    }

    case 'randomize': {
      const target = configs[delta.config];
      if (target === undefined) {
        return { kind: 'badDelta', hash, detail: `config ${delta.config} does not exist` };
      }
      // THE ZERO SENTINEL IS THE STORED VALUE, not a stand-in for one. See the
      // header: the project really does hold zeros, and the shader reads that as
      // "generate a rule from the seed". No deriver is needed to rebuild the
      // PROJECT -- only to answer what the particles then obeyed.
      configs[delta.config] = {
        ...target,
        rule: new Array<number>(target.rule.length || 80).fill(0),
        mutationSeed: delta.seed,
      };
      return { world };
    }

    case 'selection': {
      const target = configs[delta.config];
      if (target === undefined) {
        return { kind: 'badDelta', hash, detail: `config ${delta.config} does not exist` };
      }
      if (deriver === null) {
        return { kind: 'needsDeriver', hash, cohort: delta.cohort };
      }
      // THE PARENT'S rule, seed and scale -- the exact inputs `derive_entity_rule`
      // takes. Reading them off `target` is reading them off the parent state,
      // because this delta has not been applied yet.
      configs[delta.config] = {
        ...target,
        rule: deriver({
          rule: target.rule,
          cohort: delta.cohort,
          mutationSeed: target.mutationSeed,
          mutationScale: target.mutationScale,
        }).slice(),
      };
      return { world };
    }

    default: {
      const unreachable: never = delta;
      return { kind: 'badDelta', hash, detail: `unknown delta ${JSON.stringify(unreachable)}` };
    }
  }
}

/**
 * The project state at `hash`.
 *
 * Walks to the root, then replays forward. Returns a RESULT rather than throwing
 * because the interesting failures are ones a caller wants to handle rather than
 * abort on -- `needsDeriver` in particular is a routine answer when reconstructing
 * in bulk without a GPU, not an error.
 *
 * **`selected` AND `name` ARE NOT RECOVERED, and cannot be.** Neither is part of
 * state identity (`hash.ts` excludes both deliberately), so neither is in the
 * archive. The returned project carries slot 0 selected and the default name.
 * That is exactly the information a save file holds, which is why a reconstructed
 * project round-trips through `toDocument` and a share link without loss.
 */
export function reconstruct(
  archive: Archive,
  hash: string,
  deriver: RuleDeriver | null = null,
): ReconstructResult {
  const lineage = lineageOf(archive, hash);
  if (!lineage.ok) return { ok: false, failure: lineage.failure };

  const [first, ...rest] = lineage.chain;
  if (first === undefined) return { ok: false, failure: { kind: 'unknownNode', hash } };

  // The chain's head must be a stored root: it is the only node carrying a full
  // state, and every delta after it is relative.
  const root = archive.roots.get(first.hash);
  if (root === undefined) {
    return { ok: false, failure: { kind: 'missingRoot', hash: first.hash } };
  }

  const configs: SimulationConfig[] = root.configs.map((c) => ({
    // Through `makeSimulationConfig` so a config written before a field existed
    // gets that field's compatibility default -- the same tolerance
    // `persistence.ts` applies on load, and for the same reason.
    ...makeSimulationConfig(c, c),
    rule: c.rule.slice(),
  }));
  let world: WorldSettings = { ...root.world };

  for (const node of rest) {
    if (node.delta === null) {
      // A parentless node mid-chain is a contradiction, but a root reached again
      // as a descendant simply restates its own state -- take it and continue.
      const restated = archive.roots.get(node.hash);
      if (restated === undefined) {
        return { ok: false, failure: { kind: 'badDelta', hash: node.hash, detail: 'no delta and no root' } };
      }
      configs.length = 0;
      configs.push(...restated.configs.map((c) => ({ ...c, rule: c.rule.slice() })));
      world = { ...restated.world };
      continue;
    }
    const step = applyDelta(configs, world, node.delta, node.hash, deriver);
    if ('kind' in step) return { ok: false, failure: step };
    world = step.world;
  }

  return { ok: true, project: makeProject({ configs, world }) };
}

/**
 * The last node the archive recorded.
 *
 * "Last" is EXPORT ORDER, which is the order `getAll` returned from IndexedDB --
 * and that is key order, not insertion order. So this sorts by `visitedAt` and
 * takes the newest, which is what "the state I was in when I hit Download"
 * actually means.
 *
 * Ties are broken by export position, which keeps the answer deterministic for
 * two states recorded inside the same millisecond.
 */
export function latestNode(archive: Archive): ArchiveNode | null {
  let best: ArchiveNode | null = null;
  let bestAt = -Infinity;
  for (const hash of archive.order) {
    const node = archive.nodes.get(hash);
    if (node === undefined) continue;
    const at = typeof node.visitedAt === 'number' ? node.visitedAt : -Infinity;
    if (at >= bestAt) {
      bestAt = at;
      best = node;
    }
  }
  return best;
}

/**
 * Reconstruct every node, reporting what could not be done.
 *
 * The bulk entry point, and the shape most analyses want: one pass, a map of
 * results, and an explicit list of what needs a GPU rather than a silent gap.
 */
export function reconstructAll(
  archive: Archive,
  deriver: RuleDeriver | null = null,
): {
  readonly projects: ReadonlyMap<string, Project>;
  readonly failures: readonly ReconstructFailure[];
} {
  const projects = new Map<string, Project>();
  const failures: ReconstructFailure[] = [];
  for (const hash of archive.order) {
    const result = reconstruct(archive, hash, deriver);
    if (result.ok) projects.set(hash, result.project);
    else failures.push(result.failure);
  }
  return { projects, failures };
}

/**
 * One step of a session replayed: the visit, plus the state it landed on.
 *
 * `project` is null for the entries that are not project states at all --
 * preference changes and discrete commands -- and for a project visit whose node
 * could not be reconstructed, in which case `failure` says why. The three cases
 * are distinguishable: a non-project step has `visit.type !== 'project'` and no
 * failure; a broken one has both a project-typed visit and a failure.
 */
export interface ReplayStep {
  readonly record: VisitRecord;
  readonly project: Project | null;
  readonly failure: ReconstructFailure | null;
}

/**
 * The session replayed in order: every act the user took, with its resulting state.
 *
 * **THIS IS WHAT THE VISIT LOG IS FOR.** `reconstructAll` answers "what states
 * exist"; this answers "what happened, and in what order" -- including the
 * revisits, the undos and the preference changes that the node tree does not hold
 * and cannot hold. Walking `archive.visits` rather than `archive.order` is the
 * entire difference.
 *
 * RECONSTRUCTIONS ARE MEMOIZED across the walk, because a path that returns to a
 * state ten times would otherwise walk its lineage ten times -- and revisits are
 * common enough in real sessions that this is the difference between linear and
 * quadratic on the log's length. The cache is keyed by hash, which is sound
 * precisely because a hash denotes one state forever.
 *
 * Returns an empty array for an archive with no log, which is the honest answer
 * for a document exported before the log existed rather than an error: the
 * states are all still there, and `reconstructAll` is the function that wants
 * them.
 */
export function replaySession(
  archive: Archive,
  deriver: RuleDeriver | null = null,
): readonly ReplayStep[] {
  const cache = new Map<string, Project>();
  const steps: ReplayStep[] = [];

  for (const record of archive.visits) {
    const visit = record.visit;
    if (visit?.type !== 'project') {
      // A preference or a command: a real step in the session with no state of
      // its own. Passed through so the replay's ORDER is complete -- dropping
      // these would leave a log that says the user did nothing between two
      // edits when in fact they changed the world size.
      steps.push({ record, project: null, failure: null });
      continue;
    }

    const cached = cache.get(visit.hash);
    if (cached !== undefined) {
      steps.push({ record, project: cached, failure: null });
      continue;
    }

    const result = reconstruct(archive, visit.hash, deriver);
    if (result.ok) {
      cache.set(visit.hash, result.project);
      steps.push({ record, project: result.project, failure: null });
    } else {
      // NOT FATAL TO THE WALK. One unreconstructable state -- a selection node
      // with no deriver supplied, most often -- should not cost the caller the
      // other ten thousand steps. The failure travels with its step.
      steps.push({ record, project: null, failure: result.failure });
    }
  }

  return steps;
}
