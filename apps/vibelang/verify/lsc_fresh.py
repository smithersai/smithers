#!/usr/bin/env python3
"""Rebuild the vendored LemmaScript when its sources are newer than its build (decision 0018).

`.tools/bin/lsc` links to packages/lemmascript/tools/dist/lsc.js. A rebase past a LemmaScript patch changes the sources
but not that build, so without this check every proof and mutation would run the old tool and report nothing about it.
"""
import pathlib, subprocess, sys

PACKAGE = pathlib.Path(__file__).resolve().parents[3] / 'packages/lemmascript'


def stale(package: pathlib.Path = PACKAGE) -> bool:
    built = package / 'tools/dist/lsc.js'
    if not built.exists(): return True
    stamp = built.stat().st_mtime
    inputs = [package / 'package.json', package / 'tools/tsconfig.json', *(package / 'tools/src').rglob('*.ts')]
    return any(path.exists() and path.stat().st_mtime > stamp for path in inputs)


def main():
    if stale():
        print('LemmaScript sources changed since its build: rebuilding', file=sys.stderr)
        subprocess.run(['pnpm', '--dir', str(PACKAGE), 'run', 'build'], check=True, stdout=sys.stderr)
        # tsc leaves an unchanged output's time alone; mark the build as current.
        (PACKAGE / 'tools/dist/lsc.js').touch()
    if stale(): raise SystemExit('LemmaScript build is still older than its sources')


if __name__ == '__main__':
    main()
