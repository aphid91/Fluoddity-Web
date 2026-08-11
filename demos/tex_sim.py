#!/usr/bin/env python3
"""
texsim -- caption alignment, auto-captioning and clustering for image datasets,
with a texture-first bias suitable for Turing patterns and other images that
have more local structure than global object coherence.

Two embedding backends:

  clip     CLIP image/text embeddings. Supports everything (needs torch +
           open_clip or transformers). Optional random-crop aggregation so the
           model describes local texture rather than global layout.

  texture  Hand-built, no-network descriptor: radially averaged power spectrum,
           angular power distribution, Euler-characteristic curve (Minkowski),
           intensity histogram. Image-image only -- no captions -- but it is
           interpretable and isolates characteristic wavelength directly.

Commands:
  embed    Build/refresh the embedding cache.
  rank     Sort the dataset by alignment to one caption.          [clip]
  caption  Assign best/likely captions per image from a vocab.    [clip]
  cluster  Cluster the dataset, optionally naming each cluster.   [clip|texture]
  similar  Rank the dataset by similarity to a query image.       [clip|texture]

Examples:
  texsim embed imgs/ --backend clip --crops 8
  texsim rank imgs/ -c "a labyrinthine maze-like pattern" --calibrate
  texsim caption imgs/ --vocab captions.txt -k 3
  texsim cluster imgs/ -k auto --vocab captions.txt --html clusters.html
  texsim similar imgs/ -q imgs/spots_01.png --backend texture
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
CACHE_DIRNAME = ".texsim_cache"

# Generic phrases used as a background distribution so that a raw cosine of
# 0.28 can be turned into "how unusual is this caption for this image".
BACKGROUND_CAPTIONS = [
    "a photograph", "an image", "a pattern", "a texture", "a drawing",
    "a picture of an object", "a natural scene", "a close-up", "a diagram",
    "a surface", "a material", "something colorful", "something plain",
    "a smooth surface", "a rough surface", "a repeating pattern",
    "a random arrangement", "fine detail", "coarse detail", "a blurry image",
    "a sharp image", "high contrast", "low contrast", "an abstract image",
    "a scientific image", "a microscope image", "a computer generated image",
    "stripes", "spots", "noise",
]


# --------------------------------------------------------------------------
# dataset discovery
# --------------------------------------------------------------------------

def find_images(root: str, recursive: bool = True) -> list[Path]:
    p = Path(root)
    if p.is_file():
        return [p]
    it = p.rglob("*") if recursive else p.glob("*")
    files = sorted(f for f in it if f.suffix.lower() in IMAGE_EXTS)
    if not files:
        raise SystemExit(f"no images found under {root}")
    return files


def file_key(path: Path) -> str:
    st = path.stat()
    h = hashlib.sha1(f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}".encode())
    return h.hexdigest()[:16]


# --------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------

class Backend:
    name = "base"
    supports_text = False
    dim = 0

    def embed_images(self, paths: list[Path]) -> np.ndarray:
        """Return (N, C, D) -- C crops/views per image, L2-normalized rows."""
        raise NotImplementedError

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        raise NotImplementedError

    def signature(self) -> str:
        raise NotImplementedError


class ClipBackend(Backend):
    name = "clip"
    supports_text = True

    def __init__(self, model_name="ViT-B-32", pretrained="laion2b_s34b_b79k",
                 crops=1, crop_frac=0.3, seed=0, device=None, batch=32):
        self.model_name = model_name
        self.pretrained = pretrained
        self.crops = max(1, crops)
        self.crop_frac = crop_frac
        self.seed = seed
        self.batch = batch
        self._loaded = False
        self._device = device

    def _load(self):
        if self._loaded:
            return
        try:
            import torch
        except ImportError:
            raise SystemExit(
                "the clip backend needs torch.\n"
                "  pip install torch open_clip_torch\n"
                "or use --backend texture, which needs only numpy/scipy."
            )
        self.torch = torch
        self._device = self._device or (
            "cuda" if torch.cuda.is_available()
            else "mps" if getattr(torch.backends, "mps", None)
            and torch.backends.mps.is_available() else "cpu"
        )
        try:
            import open_clip
            self.model, _, self.preprocess = open_clip.create_model_and_transforms(
                self.model_name, pretrained=self.pretrained, device=self._device)
            self.tokenizer = open_clip.get_tokenizer(self.model_name)
            self._impl = "open_clip"
        except ImportError:
            try:
                from transformers import CLIPModel, CLIPProcessor
            except ImportError:
                raise SystemExit("install open_clip_torch (preferred) or transformers")
            hf = "openai/clip-vit-base-patch32"
            self.model = CLIPModel.from_pretrained(hf).to(self._device)
            self.proc = CLIPProcessor.from_pretrained(hf)
            self._impl = "hf"
        self.model.eval()
        self._loaded = True

    def signature(self) -> str:
        return f"clip:{self.model_name}:{self.pretrained}:c{self.crops}:f{self.crop_frac}:s{self.seed}"

    def _views(self, img):
        """Yield PIL views of one image: whole image, or N random crops."""
        from PIL import Image
        if self.crops == 1:
            return [img]
        rng = np.random.default_rng(self.seed)
        w, h = img.size
        side = max(16, int(self.crop_frac * min(w, h)))
        out = []
        for _ in range(self.crops):
            x = rng.integers(0, max(1, w - side + 1))
            y = rng.integers(0, max(1, h - side + 1))
            out.append(img.crop((int(x), int(y), int(x) + side, int(y) + side)))
        return out

    def embed_images(self, paths):
        self._load()
        from PIL import Image
        torch = self.torch
        tensors, owner = [], []
        for i, p in enumerate(paths):
            img = Image.open(p).convert("RGB")
            for v in self._views(img):
                if self._impl == "open_clip":
                    tensors.append(self.preprocess(v))
                else:
                    tensors.append(self.proc(images=v, return_tensors="pt")["pixel_values"][0])
                owner.append(i)
        feats = []
        with torch.no_grad():
            for s in range(0, len(tensors), self.batch):
                x = torch.stack(tensors[s:s + self.batch]).to(self._device)
                f = (self.model.encode_image(x) if self._impl == "open_clip"
                     else self.model.get_image_features(pixel_values=x))
                f = f / f.norm(dim=-1, keepdim=True)
                feats.append(f.cpu().numpy().astype(np.float32))
        feats = np.concatenate(feats, 0)
        D = feats.shape[1]
        out = np.zeros((len(paths), self.crops, D), np.float32)
        counts = np.zeros(len(paths), int)
        for f, o in zip(feats, owner):
            out[o, counts[o]] = f
            counts[o] += 1
        return out

    def embed_texts(self, texts):
        self._load()
        torch = self.torch
        with torch.no_grad():
            if self._impl == "open_clip":
                tok = self.tokenizer(texts).to(self._device)
                f = self.model.encode_text(tok)
            else:
                tok = self.proc(text=texts, return_tensors="pt", padding=True,
                                truncation=True).to(self._device)
                f = self.model.get_text_features(**tok)
            f = f / f.norm(dim=-1, keepdim=True)
        return f.cpu().numpy().astype(np.float32)


class TextureBackend(Backend):
    """Interpretable texture descriptor. No network, no torch."""
    name = "texture"
    supports_text = False

    def __init__(self, size=256, n_radial=32, n_angular=16, n_euler=16, n_hist=16):
        self.size = size
        self.n_radial = n_radial
        self.n_angular = n_angular
        self.n_euler = n_euler
        self.n_hist = n_hist

    def signature(self):
        return (f"texture:{self.size}:r{self.n_radial}:a{self.n_angular}"
                f":e{self.n_euler}:h{self.n_hist}")

    @property
    def block_slices(self):
        """Where each descriptor family lives in the vector (for --explain)."""
        i = 0
        out = {}
        for name, n in (("radial_spectrum", self.n_radial),
                        ("angular_spectrum", self.n_angular),
                        ("euler_curve", self.n_euler),
                        ("intensity_hist", self.n_hist)):
            out[name] = slice(i, i + n)
            i += n
        return out

    def _load_gray(self, path):
        from PIL import Image
        img = Image.open(path).convert("L").resize((self.size, self.size), Image.LANCZOS)
        a = np.asarray(img, np.float32) / 255.0
        return a

    def _spectra(self, a):
        x = a - a.mean()
        win = np.outer(np.hanning(x.shape[0]), np.hanning(x.shape[1]))
        P = np.abs(np.fft.fftshift(np.fft.fft2(x * win))) ** 2
        n = self.size
        cy = cx = n // 2
        yy, xx = np.mgrid[0:n, 0:n]
        r = np.hypot(yy - cy, xx - cx)
        theta = np.arctan2(yy - cy, xx - cx) % np.pi

        rmax = n // 2
        mask = (r > 0) & (r < rmax)
        # log-spaced radial bins: wavelength resolution where it matters
        edges = np.geomspace(1.0, rmax, self.n_radial + 1)
        idx = np.digitize(r[mask], edges) - 1
        vals = P[mask]
        radial = np.zeros(self.n_radial, np.float32)
        for b in range(self.n_radial):
            sel = idx == b
            if sel.any():
                radial[b] = vals[sel].mean()
        radial = radial / (radial.sum() + 1e-12)

        aidx = np.minimum((theta[mask] / np.pi * self.n_angular).astype(int),
                          self.n_angular - 1)
        angular = np.zeros(self.n_angular, np.float32)
        for b in range(self.n_angular):
            sel = aidx == b
            if sel.any():
                angular[b] = vals[sel].mean()
        angular = angular / (angular.sum() + 1e-12)
        return radial, angular

    def _euler_curve(self, a):
        """chi(t) = components(fg) - holes(fg) across intensity thresholds.

        Separates spots / labyrinths / inverted spots, which is exactly the
        Turing morphology axis. 8-connectivity fg, 4-connectivity bg.
        """
        from scipy import ndimage
        lo, hi = np.percentile(a, [2, 98])
        ts = np.linspace(lo, hi, self.n_euler)
        s8 = np.ones((3, 3), int)
        s4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], int)
        out = np.zeros(self.n_euler, np.float32)
        npix = a.size
        for i, t in enumerate(ts):
            fg = a >= t
            n_obj = ndimage.label(fg, structure=s8)[1]
            n_bg = ndimage.label(~fg, structure=s4)[1]
            holes = max(0, n_bg - 1)
            out[i] = (n_obj - holes) / (npix ** 0.5)
        return out

    def embed_images(self, paths):
        rows = []
        for p in paths:
            a = self._load_gray(p)
            radial, angular = self._spectra(a)
            euler = self._euler_curve(a)
            hist = np.histogram(a, bins=self.n_hist, range=(0, 1), density=True)[0]
            hist = (hist / (hist.sum() + 1e-12)).astype(np.float32)
            rows.append(np.concatenate([radial, angular, euler, hist]))
        return np.stack(rows).astype(np.float32)[:, None, :]  # (N,1,D)


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

def cache_path(root: str, backend: Backend) -> Path:
    d = Path(root)
    d = d if d.is_dir() else d.parent
    d = d / CACHE_DIRNAME
    d.mkdir(exist_ok=True)
    tag = hashlib.sha1(backend.signature().encode()).hexdigest()[:12]
    return d / f"{backend.name}_{tag}.npz"


def get_embeddings(paths, backend, refresh=False, quiet=False):
    """Returns (N, C, D) float32, cached per file so new images are cheap."""
    cp = cache_path(str(paths[0].parent), backend)
    keys = [file_key(p) for p in paths]
    cached: dict[str, np.ndarray] = {}
    if cp.exists() and not refresh:
        z = np.load(cp, allow_pickle=False)
        ck = [str(k) for k in z["keys"]]
        cv = z["vecs"]
        cached = {k: cv[i] for i, k in enumerate(ck)}
    missing = [i for i, k in enumerate(keys) if k not in cached]
    if missing:
        if not quiet:
            print(f"[embed] {len(missing)} new / {len(paths)} total "
                  f"({backend.signature()})", file=sys.stderr)
        new = backend.embed_images([paths[i] for i in missing])
        for j, i in enumerate(missing):
            cached[keys[i]] = new[j]
    out = np.stack([cached[k] for k in keys]).astype(np.float32)
    allk = np.array(list(cached.keys()))
    allv = np.stack([cached[k] for k in allk])
    np.savez_compressed(cp, keys=allk, vecs=allv)
    return out


# --------------------------------------------------------------------------
# aggregation + similarity
# --------------------------------------------------------------------------

def l2(x, axis=-1):
    return x / (np.linalg.norm(x, axis=axis, keepdims=True) + 1e-12)


def aggregate(E: np.ndarray, mode: str) -> np.ndarray:
    """(N,C,D) -> (N,D). 'mean' averages crops; 'max' is applied at scoring time."""
    if mode == "mean" or E.shape[1] == 1:
        return l2(E.mean(1))
    return l2(E.mean(1))


def standardize(X: np.ndarray) -> np.ndarray:
    """Dataset-level z-scoring, then L2. Needed for the texture backend, whose
    blocks live on wildly different scales; harmless-to-mildly-helpful for CLIP."""
    mu, sd = X.mean(0, keepdims=True), X.std(0, keepdims=True) + 1e-8
    return l2((X - mu) / sd)


def score_against(E: np.ndarray, q: np.ndarray, agg: str) -> np.ndarray:
    """E:(N,C,D) normalized rows, q:(D,) -> (N,) similarity."""
    sims = E @ q
    if agg == "max":
        return sims.max(1)
    if agg == "topk":
        k = max(1, sims.shape[1] // 3)
        return np.sort(sims, 1)[:, -k:].mean(1)
    return sims.mean(1)


# --------------------------------------------------------------------------
# clustering (spherical k-means, no sklearn required)
# --------------------------------------------------------------------------

def kmeans(X, k, iters=100, restarts=8, seed=0):
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(restarts):
        C = _kmeanspp(X, k, rng)
        for _ in range(iters):
            lab = (X @ C.T).argmax(1)
            newC = np.zeros_like(C)
            for j in range(k):
                m = lab == j
                newC[j] = X[m].mean(0) if m.any() else X[rng.integers(len(X))]
            newC = l2(newC)
            if np.allclose(newC, C, atol=1e-7):
                C = newC
                break
            C = newC
        inertia = (X * C[(X @ C.T).argmax(1)]).sum()
        if best is None or inertia > best[0]:
            best = (inertia, C, (X @ C.T).argmax(1))
    return best[2], best[1]


def _kmeanspp(X, k, rng):
    idx = [int(rng.integers(len(X)))]
    for _ in range(k - 1):
        d = 1.0 - (X @ X[idx].T).max(1)
        d = np.clip(d, 0, None) ** 2
        if d.sum() <= 0:
            idx.append(int(rng.integers(len(X))))
        else:
            idx.append(int(rng.choice(len(X), p=d / d.sum())))
    return l2(X[idx])


def silhouette(X, lab):
    from sklearn.metrics import silhouette_score
    if len(set(lab)) < 2:
        return -1.0
    return float(silhouette_score(X, lab, metric="cosine"))


def choose_k(X, kmin=2, kmax=10, seed=0):
    kmax = min(kmax, len(X) - 1)
    best = (-2, 2, None)
    for k in range(kmin, kmax + 1):
        lab, C = kmeans(X, k, seed=seed)
        try:
            s = silhouette(X, lab)
        except Exception:
            s = -1
        if s > best[0]:
            best = (s, k, (lab, C))
    return best[1], best[2][0], best[2][1], best[0]


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

@dataclass
class Row:
    path: str
    score: float
    z: float | None = None
    pct: float | None = None
    extra: str = ""


def print_table(rows: list[Row], header="score", show_z=True):
    w = max((len(Path(r.path).name) for r in rows), default=10)
    w = min(max(w, 12), 48)
    head = f"{'image':<{w}}  {header:>8}"
    if show_z and rows and rows[0].z is not None:
        head += f"  {'z':>7}  {'pct':>5}"
    if rows and rows[0].extra:
        head += "  detail"
    print(head)
    print("-" * len(head))
    for r in rows:
        name = Path(r.path).name
        name = name if len(name) <= w else name[:w - 1] + "\u2026"
        line = f"{name:<{w}}  {r.score:8.4f}"
        if show_z and r.z is not None:
            line += f"  {r.z:+7.2f}  {r.pct:5.1f}"
        if r.extra:
            line += f"  {r.extra}"
        print(line)


def write_csv(rows: list[Row], path: str):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["image", "score", "z", "percentile", "detail"])
        for r in rows:
            w.writerow([r.path, f"{r.score:.6f}",
                        "" if r.z is None else f"{r.z:.4f}",
                        "" if r.pct is None else f"{r.pct:.2f}", r.extra])
    print(f"[csv] {path}", file=sys.stderr)


def thumb_b64(path, size=140):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    im.thumbnail((size, size))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=82)
    return base64.b64encode(b.getvalue()).decode()


def write_html(groups: list[tuple[str, list[Row]]], path: str, title="texsim"):
    parts = [
        "<!doctype html><meta charset=utf-8><title>%s</title>" % title,
        "<style>body{font:14px/1.45 ui-sans-serif,system-ui,sans-serif;"
        "margin:2rem;background:#fafaf9;color:#1c1917}"
        "h2{margin:2rem 0 .5rem;font-size:15px;font-weight:600;"
        "border-bottom:1px solid #d6d3d1;padding-bottom:.35rem}"
        ".g{display:flex;flex-wrap:wrap;gap:10px}"
        ".c{width:140px}.c img{width:140px;border-radius:4px;display:block;"
        "background:#e7e5e4}"
        ".m{font:11px ui-monospace,monospace;color:#57534e;margin-top:3px;"
        "word-break:break-all}</style>",
        f"<h1 style='font-size:18px'>{title}</h1>",
    ]
    for name, rows in groups:
        parts.append(f"<h2>{name} <span style='color:#78716c;font-weight:400'>"
                     f"({len(rows)})</span></h2><div class=g>")
        for r in rows:
            try:
                b = thumb_b64(r.path)
                img = f"<img src='data:image/jpeg;base64,{b}'>"
            except Exception:
                img = "<img>"
            det = f"<br>{r.extra}" if r.extra else ""
            parts.append(f"<div class=c>{img}<div class=m>{Path(r.path).name}<br>"
                         f"{r.score:.4f}{det}</div></div>")
        parts.append("</div>")
    Path(path).write_text("".join(parts))
    print(f"[html] {path}", file=sys.stderr)


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def build_backend(args) -> Backend:
    if args.backend == "texture":
        return TextureBackend(size=args.size)
    return ClipBackend(model_name=args.model, pretrained=args.pretrained,
                       crops=args.crops, crop_frac=args.crop_frac, seed=args.seed)


def load_vocab(args) -> list[str]:
    if args.vocab:
        txt = Path(args.vocab).read_text()
        return [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("#")]
    return list(args.caption or [])


def need_text(backend):
    if not backend.supports_text:
        raise SystemExit(f"backend '{backend.name}' has no text encoder; "
                         "use --backend clip, or the 'cluster'/'similar' commands.")


def cmd_embed(args):
    paths = find_images(args.dataset, not args.no_recursive)
    be = build_backend(args)
    E = get_embeddings(paths, be, refresh=args.refresh)
    print(f"{len(paths)} images  ->  {E.shape[1]} view(s) x {E.shape[2]} dims  "
          f"[{be.signature()}]")


def cmd_rank(args):
    paths = find_images(args.dataset, not args.no_recursive)
    be = build_backend(args)
    need_text(be)
    E = get_embeddings(paths, be, refresh=args.refresh)
    q = be.embed_texts([args.caption_text])[0]
    s = score_against(E, q, args.agg)

    z = pct = None
    if args.calibrate:
        bg = be.embed_texts(BACKGROUND_CAPTIONS)          # (B, D)
        bgs = np.stack([score_against(E, b, args.agg) for b in bg], 1)  # (N,B)
        # Robust center/scale: a couple of background captions that happen to
        # match an image shouldn't drag the reference point. The floor stops z
        # from exploding when the background collapses to near-zero spread.
        med = np.median(bgs, 1)
        mad = np.median(np.abs(bgs - med[:, None]), 1) * 1.4826
        scale = np.maximum(mad, 0.01)
        z = (s - med) / scale
        pct = (bgs < s[:, None]).mean(1) * 100

    rows = [Row(str(paths[i]), float(s[i]),
                None if z is None else float(z[i]),
                None if pct is None else float(pct[i]))
            for i in range(len(paths))]
    rows.sort(key=lambda r: -(r.z if args.calibrate and r.z is not None else r.score))
    if args.top:
        rows = rows[:args.top]
    print(f'caption: "{args.caption_text}"')
    if args.calibrate:
        print(f"z / pct are vs {len(BACKGROUND_CAPTIONS)} background captions "
              f"-- rank by z, not raw cosine")
    print_table(rows, header="cos")
    if args.csv:
        write_csv(rows, args.csv)
    if args.html:
        write_html([(args.caption_text, rows)], args.html, "rank")


def cmd_caption(args):
    paths = find_images(args.dataset, not args.no_recursive)
    be = build_backend(args)
    need_text(be)
    vocab = load_vocab(args)
    if len(vocab) < 2:
        raise SystemExit("need >=2 captions via --vocab FILE or repeated -c")
    E = get_embeddings(paths, be, refresh=args.refresh)
    T = be.embed_texts(vocab)                                   # (V, D)
    S = np.stack([score_against(E, T[v], args.agg) for v in range(len(vocab))], 1)

    if args.normalize == "column":
        # Remove each caption's global popularity -- CLIP has strong per-text
        # priors and without this a few captions win almost every image.
        S = (S - S.mean(0, keepdims=True)) / (S.std(0, keepdims=True) + 1e-8)

    # CLIP's own logit scale (~100) is calibrated for raw cosines, which live in
    # a narrow band. After column z-scoring the scale is ~1, so 100 saturates.
    temp = args.temp if args.temp is not None else (2.0 if args.normalize == "column" else 100.0)
    L = S * temp
    L -= L.max(1, keepdims=True)              # stable softmax
    P = np.exp(L)
    P /= P.sum(1, keepdims=True)

    rows = []
    for i, p in enumerate(paths):
        order = np.argsort(-P[i])[:args.k]
        det = "  ".join(f"{vocab[j]} ({P[i, j]*100:.0f}%)" for j in order)
        rows.append(Row(str(p), float(P[i, order[0]]), extra=det))
    if args.sort_by_confidence:
        rows.sort(key=lambda r: -r.score)
    print_table(rows, header="p(best)", show_z=False)
    if args.csv:
        write_csv(rows, args.csv)
    if args.html:
        write_html([("captions", rows)], args.html, "captions")


def cmd_cluster(args):
    paths = find_images(args.dataset, not args.no_recursive)
    be = build_backend(args)
    E = get_embeddings(paths, be, refresh=args.refresh)
    X = aggregate(E, args.agg)
    if be.name == "texture" or args.standardize:
        X = standardize(X)

    if args.k == "auto":
        k, lab, C, sil = choose_k(X, seed=args.seed)
        print(f"[cluster] auto k={k} (silhouette {sil:.3f})", file=sys.stderr)
    else:
        k = int(args.k)
        lab, C = kmeans(X, k, seed=args.seed)
        try:
            print(f"[cluster] k={k} (silhouette {silhouette(X, lab):.3f})",
                  file=sys.stderr)
        except Exception:
            pass

    names = {}
    vocab = load_vocab(args)
    if vocab and be.supports_text:
        T = be.embed_texts(vocab)
        sims = C @ T.T                                       # (k, V)
        sims = sims - sims.mean(0, keepdims=True)            # de-prior captions
        for j in range(k):
            names[j] = vocab[int(sims[j].argmax())]
    elif vocab:
        print("[cluster] --vocab ignored: texture backend has no text encoder",
              file=sys.stderr)

    groups = []
    for j in range(k):
        idx = np.where(lab == j)[0]
        sc = X[idx] @ C[j]
        order = idx[np.argsort(-sc)]
        rows = [Row(str(paths[i]), float(X[i] @ C[j])) for i in order]
        label = f"cluster {j}" + (f"  \u2014  {names[j]}" if j in names else "")
        groups.append((label, rows))

    for label, rows in groups:
        print(f"\n{label}  ({len(rows)})")
        print_table(rows, header="to-centroid", show_z=False)
    if args.csv:
        flat = []
        for j, (label, rows) in enumerate(groups):
            for r in rows:
                flat.append(Row(r.path, r.score, extra=label))
        write_csv(flat, args.csv)
    if args.html:
        write_html(groups, args.html, "clusters")


def cmd_similar(args):
    paths = find_images(args.dataset, not args.no_recursive)
    be = build_backend(args)
    qp = Path(args.query)
    if not qp.exists():
        raise SystemExit(f"query image not found: {qp}")
    E = get_embeddings(paths, be, refresh=args.refresh)
    X = aggregate(E, args.agg)
    qE = get_embeddings([qp], be)
    q = aggregate(qE, args.agg)[0]
    if be.name == "texture" or args.standardize:
        # z-score the query with the dataset's own statistics
        mu, sd = X.mean(0, keepdims=True), X.std(0, keepdims=True) + 1e-8
        q = l2((q[None] - mu) / sd)[0]
        X = l2((X - mu) / sd)
    s = X @ q

    extras = [""] * len(paths)
    if args.explain and be.name == "texture":
        blocks = be.block_slices
        for i in range(len(paths)):
            parts = []
            for name, sl in blocks.items():
                a, b = l2(X[i, sl][None])[0], l2(q[sl][None])[0]
                parts.append(f"{name.split('_')[0]}={float(a @ b):.2f}")
            extras[i] = " ".join(parts)

    rows = [Row(str(paths[i]), float(s[i]), extra=extras[i]) for i in range(len(paths))]
    rows.sort(key=lambda r: -r.score)
    if args.top:
        rows = rows[:args.top]
    print(f"query: {qp.name}   backend: {be.name}")
    print_table(rows, header="cos", show_z=False)
    if args.csv:
        write_csv(rows, args.csv)
    if args.html:
        write_html([(f"similar to {qp.name}", rows)], args.html, "similar")


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="texsim", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, text_cmd=False):
        p.add_argument("dataset", help="image file or directory")
        p.add_argument("--backend", choices=["clip", "texture"], default="clip")
        p.add_argument("--model", default="ViT-B-32")
        p.add_argument("--pretrained", default="laion2b_s34b_b79k")
        p.add_argument("--crops", type=int, default=1,
                       help="CLIP: embed N random crops per image instead of the "
                            "whole frame. 8-16 makes it describe local texture.")
        p.add_argument("--crop-frac", type=float, default=0.3,
                       help="crop side as a fraction of the short edge")
        p.add_argument("--agg", choices=["mean", "max", "topk"], default="mean",
                       help="how to combine crop scores")
        p.add_argument("--size", type=int, default=256,
                       help="texture backend: analysis resolution")
        p.add_argument("--seed", type=int, default=0)
        p.add_argument("--refresh", action="store_true", help="ignore cache")
        p.add_argument("--no-recursive", action="store_true")
        p.add_argument("--csv")
        p.add_argument("--html", help="write a contact sheet")
        p.add_argument("--standardize", action="store_true",
                       help="dataset-level z-score before comparing")

    p = sub.add_parser("embed", help="build the cache")
    common(p); p.set_defaults(func=cmd_embed)

    p = sub.add_parser("rank", help="sort dataset by alignment to one caption")
    common(p)
    p.add_argument("-c", "--caption", dest="caption_text", required=True)
    p.add_argument("--calibrate", action="store_true",
                   help="report z-score vs background captions (recommended)")
    p.add_argument("--top", type=int)
    p.set_defaults(func=cmd_rank)

    p = sub.add_parser("caption", help="assign best/likely captions per image")
    common(p)
    p.add_argument("--vocab", help="file with one caption per line")
    p.add_argument("-c", "--caption", action="append", help="repeatable")
    p.add_argument("-k", type=int, default=3, help="captions to show per image")
    p.add_argument("--temp", type=float, default=None,
                   help="softmax temperature (default: 2 with --normalize column, "
                        "100 with none, matching CLIP's logit scale)")
    p.add_argument("--normalize", choices=["none", "column"], default="column",
                   help="'column' removes each caption's global prior")
    p.add_argument("--sort-by-confidence", action="store_true")
    p.set_defaults(func=cmd_caption)

    p = sub.add_parser("cluster", help="cluster the dataset")
    common(p)
    p.add_argument("-k", default="auto", help="number of clusters, or 'auto'")
    p.add_argument("--vocab", help="optional captions used to name clusters")
    p.add_argument("-c", "--caption", action="append")
    p.set_defaults(func=cmd_cluster)

    p = sub.add_parser("similar", help="rank by similarity to a query image")
    common(p)
    p.add_argument("-q", "--query", required=True)
    p.add_argument("--top", type=int)
    p.add_argument("--explain", action="store_true",
                   help="texture backend: per-descriptor breakdown")
    p.set_defaults(func=cmd_similar)

    args = ap.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()