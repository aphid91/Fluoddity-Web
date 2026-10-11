/**
 * How cohorts partition the grid. The ONE definition, shared by the shader
 * uniforms (via `cohortIndexMap` / `cohortRects`), the host pick, the initial
 * conditions and the CPU reference step.
 *
 * N cohorts become `cols = ceil(sqrt N)` columns and `rows = ceil(N / cols)`
 * rows. Full rows hold `cols` cohorts; the last row holds the remainder,
 * stretched to the full width so every cell belongs to exactly one cohort.
 * Boundaries are integer: row `r` starts at `floor(r * H / rows)`, and within a
 * row of `n` cohorts cohort `i` starts at `floor(i * W / n)`.
 *
 * Cohorts are numbered row-major from the TOP-LEFT of the grid (y = 0).
 */

export interface CohortRect {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
}

export function cohortGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.round(n));
  const cols = Math.ceil(Math.sqrt(count));
  return { cols, rows: Math.ceil(count / cols) };
}

export function cohortRects(n: number, W: number, H: number): CohortRect[] {
  const count = Math.max(1, Math.round(n));
  const { cols, rows } = cohortGrid(count);
  const rects: CohortRect[] = [];
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * H) / rows);
    const y1 = Math.floor(((r + 1) * H) / rows);
    const inRow = r < rows - 1 ? cols : count - cols * (rows - 1);
    for (let i = 0; i < inRow; i++) {
      const x0 = Math.floor((i * W) / inRow);
      const x1 = Math.floor(((i + 1) * W) / inRow);
      rects.push({ x0, y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return rects;
}

/** The cohort owning cell (x, y), by the same arithmetic as `cohortRects`. */
export function cohortAt(n: number, W: number, H: number, x: number, y: number): number {
  const count = Math.max(1, Math.round(n));
  const { cols, rows } = cohortGrid(count);
  const cy = Math.min(H - 1, Math.max(0, Math.floor(y)));
  const cx = Math.min(W - 1, Math.max(0, Math.floor(x)));
  let r = Math.min(rows - 1, Math.floor((cy * rows) / H));
  while (r > 0 && Math.floor((r * H) / rows) > cy) r--;
  while (r < rows - 1 && Math.floor(((r + 1) * H) / rows) <= cy) r++;
  const inRow = r < rows - 1 ? cols : count - cols * (rows - 1);
  let i = Math.min(inRow - 1, Math.floor((cx * inRow) / W));
  while (i > 0 && Math.floor((i * W) / inRow) > cx) i--;
  while (i < inRow - 1 && Math.floor(((i + 1) * W) / inRow) <= cx) i++;
  return r * cols + i;
}

/** Per-cell cohort index, row-major. What the shaders read. */
export function cohortIndexMap(n: number, W: number, H: number): Uint32Array {
  const map = new Uint32Array(W * H);
  cohortRects(n, W, H).forEach((r, k) => {
    for (let y = r.y0; y < r.y0 + r.h; y++) map.fill(k, y * W + r.x0, y * W + r.x0 + r.w);
  });
  return map;
}

/** `((a % m) + m) % m` -- the shaders' wrap. */
export function wrapMod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/**
 * The cell a neighbour offset reaches, or -1 for "outside, reads zero".
 *
 *  - FENCED: wraps inside the cell's own cohort rectangle (a torus per cohort).
 *  - Else WRAP: wraps on the whole grid.
 *  - Else ZERO: off-grid neighbours read zero.
 */
export function neighbourIndex(
  x: number,
  y: number,
  dx: number,
  dy: number,
  W: number,
  H: number,
  fenced: CohortRect | null,
  wrap: boolean,
): number {
  if (fenced !== null) {
    const nx = fenced.x0 + wrapMod(x - fenced.x0 + dx, fenced.w);
    const ny = fenced.y0 + wrapMod(y - fenced.y0 + dy, fenced.h);
    return ny * W + nx;
  }
  const nx = x + dx;
  const ny = y + dy;
  if (wrap) return wrapMod(ny, H) * W + wrapMod(nx, W);
  if (nx < 0 || ny < 0 || nx >= W || ny >= H) return -1;
  return ny * W + nx;
}
