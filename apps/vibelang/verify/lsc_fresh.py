#!/usr/bin/env python3
"""Rebuild the vendored LemmaScript when its sources are newer than its build (decision 0018).

`.tools/bin/lsc` links to packages/lemmascript/tools/dist/lsc.js by a relative path. `run-heavy --add` delivers it to a
box as a copied file, which can't resolve ts-morph, so `link` restores the link before every run. A rebase past a LemmaScript patch changes the sources
but not that build, so without this check every proof and mutation would run the old tool and report nothing about it.
"""
import os, pathlib, subprocess, sys

PACKAGE = pathlib.Path(__file__).resolve().parents[3] / 'packages/lemmascript'
TOOLS = pathlib.Path(__file__).resolve().parent / '.tools'


def stale(package: pathlib.Path = PACKAGE) -> bool:
    built = package / 'tools/dist/lsc.js'
    if not built.exists(): return True
    stamp = built.stat().st_mtime
    inputs = [package / 'package.json', package / 'tools/tsconfig.json', *(package / 'tools/src').rglob('*.ts')]
    return any(path.exists() and path.stat().st_mtime > stamp for path in inputs)


def link(tools: pathlib.Path = TOOLS, package: pathlib.Path = PACKAGE):
    """Make tools/bin/lsc a relative link to the package build, replacing a copy or an absolute link."""
    lsc = tools / 'bin/lsc'
    target = os.path.relpath(package / 'tools/dist/lsc.js', lsc.parent)
    if lsc.is_symlink() and os.readlink(lsc) == target: return
    lsc.parent.mkdir(parents=True, exist_ok=True)
    if lsc.is_symlink() or lsc.exists(): lsc.unlink()
    lsc.symlink_to(target)


def main():
    if stale():
        print('LemmaScript sources changed since its build: rebuilding', file=sys.stderr)
        subprocess.run(['pnpm', '--dir', str(PACKAGE), 'run', 'build'], check=True, stdout=sys.stderr)
        # tsc leaves an unchanged output's time alone; mark the build as current.
        (PACKAGE / 'tools/dist/lsc.js').touch()
    if stale(): raise SystemExit('LemmaScript build is still older than its sources')
    link()


if __name__ == '__main__':
    main()
