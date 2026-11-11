"""Reuse of a module's proof when nothing it reads has changed (decision 0018).

A value import of a proved module makes its contracts axioms of the caller, so the run proves that module fresh, and
its whole value-import tree with it. That kept the soundness but made a one-module run re-prove `conversation.vibe`
(2,016 s instead of 33 s). A passing result is now stored under a key over everything that decides it:

- the module's path in the app and whether the app's checked proof steps apply (`proof_additions.py`);
- every file TypeScript reads for the staged module (`proof_inputs.cjs`): its own copy, each imported module's staged
  copy or emitted declaration, the packages and libraries those name, each by path and content;
- LemmaScript's build and its TypeScript, Dafny's version, the run's LemmaScript configuration, and the harness itself
  (every Python module the run loaded from this folder, the Node scripts and the install scripts).

An unchanged import is then reused and any change to it, to a file it reads or to a tool re-proves it. A failed proof
and a mutant are never stored. `VERIFY_FRESH=1` ignores stored proofs and proves every module.
"""
import hashlib, json, os, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[2]
FORMAT = 1


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize(text: str, run: pathlib.Path, repo: pathlib.Path = REPO) -> str:
    """A run's folder and the checkout's path appear in staged paths and declarations; neither decides a proof."""
    return text.replace(str(run), '<run>').replace(str(repo), '<repo>')


def file_entry(path: pathlib.Path, run: pathlib.Path, memo: dict) -> list:
    path = pathlib.Path(path)
    if path not in memo:
        data = path.read_bytes()
        try: data = normalize(data.decode(), run).encode()
        except UnicodeDecodeError: pass
        memo[path] = digest(data)
    return [normalize(str(path), run), memo[path]]


def tree_digest(folder: pathlib.Path) -> str:
    folder = pathlib.Path(folder)
    if not folder.exists(): return 'missing'
    return digest(json.dumps([[p.relative_to(folder).as_posix(), digest(p.read_bytes())]
                              for p in sorted(folder.rglob('*')) if p.is_file()]).encode())


def harness_digest(root: pathlib.Path = ROOT) -> str:
    loaded = {pathlib.Path(m.__file__).resolve() for m in list(sys.modules.values()) if getattr(m, '__file__', None)}
    files = sorted({p for p in loaded if p.parent == root and p.suffix == '.py'}
                   | {p for p in root.glob('*.cjs') if not p.stem.endswith('_test')}
                   | set(root.glob('*.sh')))
    return digest(json.dumps([[p.name, digest(p.read_bytes())] for p in files]).encode())


def tools_digest(tools: pathlib.Path, package: pathlib.Path) -> str:
    """LemmaScript's build and the Dafny release, which pins its Z3. The TypeScript version comes with each key's reads."""
    lsc = pathlib.Path(tools) / 'bin/lsc'
    dist = lsc.resolve().parent if lsc.exists() else pathlib.Path(package) / 'tools/dist'
    dafny = pathlib.Path(tools) / 'bin/dafny'
    version = subprocess.run([str(dafny), '--version'], capture_output=True, text=True, timeout=120).stdout.strip() if dafny.exists() else 'missing'
    return digest(json.dumps({'lsc': tree_digest(dist), 'dafny': version}).encode())


def program_inputs(tsconfig: pathlib.Path, roots) -> dict:
    roots = [pathlib.Path(r) for r in roots]
    if not roots: return {}, {}
    p = subprocess.run(['node', str(ROOT / 'proof_inputs.cjs'), str(tsconfig), *map(str, roots)], capture_output=True, text=True, timeout=600)
    if p.returncode: raise SystemExit(f'Cannot list the files a proof reads:\n{p.stdout}{p.stderr}')
    listed = json.loads(p.stdout)
    versions = {'typescript': listed['typescript'], 'ts-morph': listed['tsMorph']}
    return versions, {pathlib.Path(k): [pathlib.Path(f) for f in v] for k, v in listed['inputs'].items()}


def keys(app, run, roots, config: dict, proof_steps: bool, tools: str, harness: str) -> dict:
    """The key of each staged root, from what TypeScript reads for it (`roots` maps a staged file to its source)."""
    app, run = pathlib.Path(app), pathlib.Path(run)
    versions, inputs = program_inputs(run / 'source/tsconfig.json', list(roots))
    memo = {}
    settings = {k: v for k, v in config.items() if k != 'proof-dir'}
    found = {}
    for staged, origin in roots.items():
        read = sorted(file_entry(f, run, memo) for f in inputs[pathlib.Path(staged)])
        found[staged] = digest(json.dumps({'format': FORMAT, 'module': pathlib.Path(origin).relative_to(app).as_posix(),
                                           'proof_steps': proof_steps, 'config': settings, 'tools': tools,
                                           'harness': harness, 'typescript': versions, 'reads': read}, sort_keys=True).encode())
    return found


def store_folder(app) -> pathlib.Path:
    return pathlib.Path(app) / 'verify/.checks/proofs'


def load(app, key: str):
    if os.environ.get('VERIFY_FRESH') == '1': return None
    path = store_folder(app) / (key + '.json')
    try: entry = json.loads(path.read_text())
    except (OSError, ValueError): return None
    return entry if entry.get('key') == key and entry.get('result', {}).get('exit') == 0 else None


def save(app, key: str, result: dict, run: pathlib.Path) -> None:
    if result.get('exit') != 0 or result.get('mutation') or result.get('cached'): return
    folder = store_folder(app); folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / (key + '.json.' + str(os.getpid()))
    temporary.write_text(json.dumps({'key': key, 'run': pathlib.Path(run).name, 'result': result}))
    os.replace(temporary, folder / (key + '.json'))
