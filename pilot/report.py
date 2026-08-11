"""Turning a finished run's manifest into something a human can read.

WHY THIS IS A FILE AND NOT A PRINT. A run's results used to exist only as
terminal output, which is lost the moment the window closes -- and a long
overnight run is exactly the one whose results you come back to later. The
manifest always held everything, but reading 8,000 lines of JSON is not
"coming back to the results".

Pure: reads a manifest, writes text. Never touches the app, never embeds
anything. `python -m pilot.run --report <dir>` is the entry point, and it works
on a run that finished months ago.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

#: How many at each end. 32 is enough to see a trend without being a list
#: nobody scrolls to the bottom of.
DEFAULT_COUNT = 32


def rank(candidates):
    """Scored candidates, best first. Unscored ones are dropped.

    Ties break on id so the ordering is stable between calls -- a report that
    reshuffles equal scores on every run is one you cannot diff.
    """
    scored = [c for c in candidates if c.score is not None]
    return sorted(scored, key=lambda c: (-c.score, c.id))


def _row(candidate, root=None):
    """One line: score, id, provenance, and where the picture is."""
    capture = candidate.capture_path or ''
    if root is not None and capture:
        try:
            capture = str(Path(capture).relative_to(root))
        except ValueError:
            pass                    # absolute path from another machine
    parent = candidate.parent_id or '-'
    scale = ('-' if candidate.mutation_scale is None
             else f"{candidate.mutation_scale:.3f}")
    return (f"{candidate.score:+10.4f}  {candidate.id:<20} "
            f"gen{candidate.generation:<4} {candidate.origin:<10} "
            f"parent={parent:<20} scale={scale:<7} {capture}")


def _section(title, rows, root):
    out = [title, '-' * len(title)]
    out.extend(_row(c, root) for c in rows)
    out.append('')
    return out


def build(candidates, cfg=None, count=DEFAULT_COUNT, root=None, title=None):
    """The report, as a list of lines."""
    ordered = rank(candidates)
    total = len(candidates)
    lines = []

    lines.append(title or "Fluoddity search results")
    lines.append('=' * len(lines[0]))
    lines.append('')

    if cfg is not None:
        captions = list(getattr(cfg, 'captions', None) or [])
        if captions:
            objective = f'caption "{captions[0]}"'
        elif cfg.reference_dir:
            objective = f"reference images from {cfg.reference_dir}"
        else:
            objective = "no objective (constant scorer)"
        lines.append(f"objective     {objective}")
        for extra in captions[1:]:
            lines.append(f'  or          "{extra}"')
        if len(captions) > 1:
            lines.append(f"  combined by {cfg.caption_aggregate}")
        for negative in cfg.negative_captions:
            lines.append(f'  minus       "{negative}"')
        lines.append(f"backend       {cfg.backend}"
                     f"{', grayscale' if cfg.grayscale else ', colour'}"
                     f"{', calibrated' if captions and cfg.calibrate else ''}")
        lines.append(f"world_size    {cfg.world_size}   "
                     f"warmup {cfg.warmup_steps} steps   "
                     f"capture {cfg.capture_size}px")
        lines.append(f"beam          {cfg.beam_width} x "
                     f"{cfg.children_per_parent} children + "
                     f"{cfg.immigrants} immigrants")
        lines.append('')

    lines.append(f"candidates    {total} recorded, {len(ordered)} scored")
    if ordered:
        generations = max(c.generation for c in ordered) + 1
        origins = Counter(c.origin for c in ordered)
        lines.append(f"generations   {generations}")
        lines.append("origins       " + ", ".join(
            f"{name} {n}" for name, n in sorted(origins.items())))
        lines.append(f"score range   {ordered[-1].score:+.4f} .. "
                     f"{ordered[0].score:+.4f}")
    lines.append('')

    if not ordered:
        lines.append("Nothing scored -- no ranking to report.")
        return lines

    lines.extend(_section(f"TOP {min(count, len(ordered))}",
                          ordered[:count], root))
    # Skipped when the run is small enough that the two halves would overlap:
    # printing the same candidate as both best and worst is just confusing.
    if len(ordered) > count:
        bottom = ordered[-count:]
        lines.extend(_section(f"BOTTOM {len(bottom)}", bottom, root))

    return lines


def write(path, candidates, cfg=None, count=DEFAULT_COUNT, root=None,
          title=None):
    """Write the report. Returns the path."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = build(candidates, cfg=cfg, count=count, root=root, title=title)
    target.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return target


def dedupe(candidates):
    """Keep the LAST row for each id -- what the files on disk actually show.

    Only matters for folders written before ids carried a session tag. Several
    runs sharing a folder produced colliding ids, each overwriting the
    previous one's capture and config, so for those the last row is the only
    one whose files still describe it. Returns (kept, shadowed_count).
    """
    last = {}
    for candidate in candidates:
        last[candidate.id] = candidate
    return list(last.values()), len(candidates) - len(last)
