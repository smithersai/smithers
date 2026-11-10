"""Production discovery follows LemmaScript's whitespace-tolerant verify directive."""
import pathlib
import re

VERIFY = re.compile(r'^[ \t]*//@[ \t]+verify\b', re.M)

def production_sources(app: pathlib.Path):
    return sorted(p for folder in ('src', 'worker', 'scripts') for p in (app / folder).rglob('*.vibe')
                  if VERIFY.search(p.read_text()))

def require_proved(dependency: pathlib.Path, production) -> None:
    """A proof reads an imported module's contracts as axioms, so the module must itself be a proved production source."""
    if dependency.resolve() not in {p.resolve() for p in production}:
        raise SystemExit(f'Proof import {dependency} is not a marked production module: its contracts would be unproved axioms')

# LemmaScript renames a TypeScript name that Dafny reserves (`fresh` becomes `fresh_`) and one with a leading `_`
# (`_x` becomes `i_x`); see `dafnyBaseName` in packages/lemmascript/tools/src/dafny-emit.ts. The keyword set is read
# from that file so the harness and the emitter cannot disagree.
EMITTER = pathlib.Path(__file__).resolve().parents[3] / 'packages/lemmascript/tools/src/dafny-emit.ts'

def dafny_keywords(emitter: pathlib.Path = EMITTER):
    block = re.search(r'const DAFNY_KEYWORDS = new Set\(\[(.*?)\]\);', emitter.read_text(), re.S)
    if block is None: raise SystemExit(f'No DAFNY_KEYWORDS set in {emitter}')
    words = set(re.findall(r'"(\w+)"', re.sub(r'/\*.*?\*/', '', block.group(1), flags=re.S)))
    if not words: raise SystemExit(f'Empty DAFNY_KEYWORDS set in {emitter}')
    return words

def dafny_name(name: str, keywords=None) -> str:
    """The base name LemmaScript emits for a TypeScript declaration named `name`."""
    if name in (dafny_keywords() if keywords is None else keywords): return name + '_'
    if name.startswith('_'): return 'i' + name
    return name
