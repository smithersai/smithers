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

    before=''
    for line in dependency.read_text().splitlines():
        function=re.match(r'\s*(?:export\s+)?function\s+(\w+)',line)
        if function:
            if re.search(r'//@\s*(?:ensures|requires)\b',before) and not VERIFY.search(before):
                raise SystemExit(f'Proof import {dependency}: contract on unmarked function {function.group(1)} would be an unproved axiom')
            before=''
        elif line.lstrip().startswith('//') or not line.strip():before+='\n'+line
        else:before=''

def proof_dependencies(roots,production):
    """Every imported value contract must have a fresh production proof; types carry no callable axiom."""
    import hashlib, json, subprocess
    scanner=pathlib.Path(__file__).with_name('proof_imports.cjs')
    found=[];seen=set();visited=set();snapshots={};pending=list(roots);edges={}
    while pending:
        source=pathlib.Path(pending.pop()).resolve()
        if source in visited:continue
        visited.add(source)
        edges[source]=[]
        snapshot=source.read_bytes()
        snapshots[source]=hashlib.sha256(snapshot).hexdigest()
        result=subprocess.run(['node',str(scanner),str(source)],capture_output=True,text=True,timeout=120)
        if source.read_bytes()!=snapshot:raise SystemExit(f'Proof source changed while inspecting imports: {source}')
        if result.returncode:raise SystemExit(f'Cannot inspect proof imports of {source}: {result.stderr}')
        for item in json.loads(result.stdout):
            if not item['values']:continue
            spec=item['module']
            if not spec.startswith('.'):
                raise SystemExit(f'Proof import {spec} of {source} is an unproved external value module')
            dependency=(source.parent/spec).resolve()
            require_proved(dependency,production)
            edges[source].append(dependency)
            if dependency not in seen:
                seen.add(dependency);found.append(dependency);pending.append(dependency)
    # Separate modular proofs cannot establish termination through mutually
    # assumed contracts. Reject cycles instead of letting two lies justify each other.
    active=set();complete=set()
    def visit(source):
        if source in active:raise SystemExit(f'Cyclic proof value imports require a joint proof: {source}')
        if source in complete:return
        active.add(source)
        for dependency in edges[source]:visit(dependency)
        active.remove(source);complete.add(source)
    for source in edges:visit(source)
    return sorted(found),snapshots

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


def enclosing_symbol(generated_lines, line):
    """The generated Dafny function, method or lemma whose declaration precedes 1-based `line`, `opaque` included."""
    for text in generated_lines[:line][::-1]:
        match = re.match(r'(?:(?:ghost|opaque) )?(?:function|method|lemma)\s+(\w+)', text)
        if match: return match.group(1)
    return None
