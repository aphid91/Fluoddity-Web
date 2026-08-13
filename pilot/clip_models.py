"""The CLIP models a run may choose between, under short names.

WHY A REGISTRY AND NOT A CHECKPOINT STRING IN THE CONFIG. open_clip identifies a
model by a *pair* -- an architecture ("ViT-L-14") and a pretrained tag
("laion2b_s32b_b82k") -- and the tag is an opaque record of how the weights were
trained: samples seen, batch size, dataset. Writing that pair into search.json
would mean every config carried two strings that cannot be checked by eye, where
a single wrong character produces either a download of the wrong weights or an
error from deep inside open_clip. It also invites configs that differ only in
their tag, which is a difference nobody can read.

So a config says "L14" and this table says what that means. The short name is
what a person types and what the GUI shows; the pair is an implementation
detail that lives in one place and can be corrected without touching a config.

THE NAMES ARE PART OF THE CACHE KEY, indirectly: ClipBackend.signature()
includes the architecture, so vectors from two different models can never be
served for each other. Renaming an entry here would orphan that model's cached
embeddings (they would simply be re-embedded), so prefer adding over renaming.

Sizes below are the download, which is what actually costs you the first time.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ClipModel:
    """One selectable model: what to load, and what to say about it."""

    #: The short name a config and the GUI use.
    key: str
    #: open_clip's architecture name.
    architecture: str
    #: open_clip's pretrained tag -- which weights for that architecture.
    pretrained: str
    #: Embedding width. Recorded for the tooltip, not used to load anything.
    dim: int
    #: Roughly what the weights cost to download.
    download: str
    #: One line for the GUI tooltip: what this is for.
    blurb: str
    #: Python modules this model needs beyond torch and open_clip itself.
    #:
    #: SigLIP is the reason this exists. Its text side uses a SentencePiece
    #: tokenizer that open_clip loads through `transformers`, rather than the
    #: built-in BPE every ViT-B/L CLIP uses -- so open_clip alone builds the
    #: MODEL fine and then raises ImportError from get_tokenizer, several
    #: seconds and a multi-gigabyte download later.
    extra_requires: tuple = ()


#: In increasing order of cost, which is also the order the GUI shows them.
#:
#: B32 is the default and has been the whole history of this project's scores:
#: every cached embedding and every report predating the model switch is B32, so
#: it stays first and stays the fallback.
#:
#: L14 is the standard step up -- the same CLIP training objective at a larger
#: architecture and a finer patch, so its vectors mean the same *kind* of thing
#: and are simply better at it. The obvious thing to try when B32 cannot tell
#: two clusters apart.
#:
#: SO400M is a SigLIP model, not a CLIP one: trained with a sigmoid pairwise
#: loss instead of the softmax contrastive loss, at a shape found by a scaling
#: search rather than chosen round. It is the strongest of the three on text
#: retrieval by a clear margin, and 384px means it sees a crop at nearly twice
#: the linear resolution -- which matters here, since crops are what makes this
#: describe texture. It is also several times slower and a 3.5GB download, so it
#: is a deliberate choice rather than the default.
MODELS = (
    ClipModel(
        key='B32',
        architecture='ViT-B-32',
        pretrained='laion2b_s34b_b79k',
        dim=512,
        download='~600MB',
        blurb="Fast, and what every existing score in this project was "
              "measured with. The default.",
    ),
    ClipModel(
        key='L14',
        architecture='ViT-L-14',
        pretrained='laion2b_s32b_b82k',
        dim=768,
        download='~1.7GB',
        blurb="Bigger CLIP, finer patches. Noticeably better at separating "
              "patterns B32 lumps together; a few times slower.",
    ),
    ClipModel(
        key='SO400M',
        architecture='ViT-SO400M-14-SigLIP-384',
        pretrained='webli',
        dim=1152,
        download='~3.5GB',
        blurb="SigLIP at 384px -- the strongest of the three on text, and it "
              "sees crops at nearly twice the resolution. Slowest by far. "
              "Needs transformers installed for its tokenizer.",
        extra_requires=('transformers',),
    ),
)

#: The one a config gets when it does not say. B32, because it is what every
#: embedding already in a cache and every score already in a report was
#: computed with -- defaulting to anything else would silently invalidate them.
DEFAULT = 'B32'

_BY_KEY = {m.key: m for m in MODELS}

#: Accepted spellings for each key, lowercased. The names people actually write
#: for these models differ from the keys by punctuation more than by substance,
#: and rejecting "ViT-B/32" in favour of "B32" would be pedantry about a config
#: whose meaning is perfectly clear.
_ALIASES = {
    'B32': ('b32', 'b/32', 'vit-b-32', 'vit-b/32', 'vit-b32', 'base'),
    'L14': ('l14', 'l/14', 'vit-l-14', 'vit-l/14', 'vit-l14', 'large'),
    'SO400M': ('so400m', 'so-400m', 'siglip', 'siglip-so400m',
               'vit-so400m-14-siglip-384'),
}

#: alias -> key, built once. Includes each key as its own alias.
_LOOKUP = {alias: key
           for key, aliases in _ALIASES.items()
           for alias in (key.lower(),) + aliases}


def keys():
    """The short names, in display order."""
    return tuple(m.key for m in MODELS)


def normalize(name):
    """The canonical key for `name`, or None if it is not one of ours.

    Returns None rather than raising so a caller can decide: the config
    validator wants to report it as one problem among several, while `get`
    wants to fail loudly.
    """
    if not name:
        return DEFAULT
    return _LOOKUP.get(str(name).strip().lower().replace('_', '-'))


def get(name):
    """The ClipModel for `name`. Raises ValueError with the valid keys.

    The error names the alternatives because the commonest way to get here is a
    typo in a config, and "unknown clip_model 'L-14'" without a list leaves the
    reader guessing at punctuation.
    """
    key = normalize(name)
    if key is None:
        raise ValueError(
            f"unknown clip_model {name!r}; expected one of "
            f"{', '.join(keys())}")
    return _BY_KEY[key]


def missing_requirements(name):
    """Modules `name` needs that are not installed, as install advice.

    CHECKED BEFORE THE DOWNLOAD, not after. open_clip builds a SigLIP model
    happily and only reaches its tokenizer afterwards, so without this the
    failure arrives several minutes and 3.5GB into the run, wearing open_clip's
    error message rather than its own.

    Import rather than metadata lookup: what matters is whether `import
    transformers` will work in this interpreter, which a distribution listing
    can disagree with.
    """
    import importlib.util

    model = get(name)
    missing = [m for m in model.extra_requires
               if importlib.util.find_spec(m) is None]
    if not missing:
        return []
    return [f"the {model.key} model needs {' and '.join(missing)} for its "
            f"tokenizer: pip install {' '.join(missing)}"]


def describe(name):
    """A short 'L14 -- ViT-L-14 / laion2b (~1.7GB)' for status lines."""
    model = get(name)
    return (f"{model.key} -- {model.architecture} / "
            f"{model.pretrained.split('_')[0]} ({model.download})")
