#!/usr/bin/env python3
"""Which mutants no longer typecheck, without Dafny.

A mutant that does not typecheck proves nothing: its case is stale, usually because the code around it changed type
(`actions-click-epoch`, 2026-11-13: `epoch: null` after `LoadActions.epoch` became `number`). `check.py` counts such a
mutant invalid and proves the rest of its batch; `broken.py` then fails, naming it. The landing check runs this file
(about 40 s) so a case is fixed before a gate run finds it.

  python3 verify/mutant_types.py

writes every mutant into `.checks/types-*`, typechecks them in one strict program and prints each invalid case with its
first diagnostic. Exits 1 when any case is invalid or anything else fails to typecheck.
"""
import concurrent.futures, json, pathlib, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent
CHUNK = 500


def typecheck(files, cwd=ROOT):
    """typecheck.cjs --json over `files`: {resolved path or '': diagnostic text}. Raises on a tool failure."""
    p = subprocess.run(['node', str(ROOT / 'typecheck.cjs'), '--json', *[str(f) for f in files]], cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=1800)
    if p.returncode: raise SystemExit(f'typecheck.cjs failed ({p.returncode}):\n{p.stderr[-4000:]}')
    report = json.loads(p.stdout)
    return {(str(pathlib.Path(f).resolve()) if f else ''): text for f, text in report['diagnostics'].items()}, report['files']


def split(diagnostics, mutants):
    """(invalid, other): diagnostics in a mutant's own file, keyed by the mutant's path, and every other diagnostic,
    which no single mutant explains (a staged dependency, a declaration, the options)."""
    mutants = {str(pathlib.Path(m).resolve()) for m in mutants}
    invalid = {f: text for f, text in diagnostics.items() if f in mutants}
    other = {f: text for f, text in diagnostics.items() if f not in mutants}
    return invalid, other


def first_line(text):
    return next((line for line in text.splitlines() if line.strip()), '')


def main():
    # A mutant importing main.vibe's types reads its emitted declaration, which needs the generated wiki modules.
    app = ROOT.parent
    if not all((app / name).exists() for name in ('src/assets/wiki.generated.vibe', 'src/assets/wikiIndex.generated.vibe')):
        subprocess.run(['node', '--import=vibelang/register', 'scripts/wiki.vibe'], cwd=app, check=True, stdout=subprocess.DEVNULL)
    checks = ROOT / '.checks'; checks.mkdir(exist_ok=True)
    out = pathlib.Path(tempfile.mkdtemp(prefix='types-', dir=checks))
    try:
        subprocess.run([sys.executable, str(ROOT / 'mutations.py'), str(out)], check=True, stdout=subprocess.DEVNULL)
        (out / 'tsconfig.json').write_text(json.dumps({'extends': str(ROOT.parent / 'tsconfig.json'), 'files': [], 'include': [], 'exclude': []}))
        manifest = json.loads((out / 'manifest.json').read_text())
        mutants = [out / f'{name}.ts' for name in manifest]
        # One program over every mutant peaks at 2.5 GB and ran out of heap on a 4 GB box (job f90f71470fc88e8c695a3d38);
        # 500 per program peaks at 785 MB. Two programs at a time.
        chunks = [mutants[i:i + CHUNK] for i in range(0, len(mutants), CHUNK)]
        diagnostics, files = {}, 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for found, checked in pool.map(typecheck, chunks):
                diagnostics.update(found); files += checked
        invalid, other = split(diagnostics, mutants)
        for path, text in sorted(invalid.items()):
            name = pathlib.Path(path).stem; item = manifest[name]
            print(f"invalid mutant: {name} ({item['source']} {item['function']}): {first_line(text)}")
        for path, text in sorted(other.items()):
            print(f'typecheck failure outside any mutant: {path or "(no file)"}: {first_line(text)}')
        print(f'mutant types: {len(manifest)} mutants in {len(chunks)} programs ({files} files), {len(invalid)} invalid, {len(other)} other failures')
        return 1 if invalid or other else 0
    finally:
        shutil.rmtree(out, ignore_errors=True)
        shutil.rmtree(out.with_name(out.name + '.declarations'), ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
