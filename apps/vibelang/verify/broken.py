#!/usr/bin/env python3
"""Every static mutation must reach Dafny and fail a contract in its intended function."""
import json, pathlib, re, subprocess, sys
root=pathlib.Path(__file__).resolve().parent
subprocess.run([sys.executable, str(root/'mutations.py'), '--check'], check=True)
p=subprocess.run(['bash',str(root/'check.sh'),str(root/'broken')], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
print(p.stdout, end='')
m=re.search(r'results: (.+/summary.json)',p.stdout)
if not m: raise SystemExit('FAIL: no proof summary; tool/typecheck failure does not count')
summary=json.loads(pathlib.Path(m.group(1)).read_text())
manifest=json.loads((root/'broken/manifest.json').read_text())
if summary['total'] != len(manifest) or p.returncode != 1: raise SystemExit('FAIL: unexpected mutation count / runner exit')
for r in summary['results']:
    item=manifest[pathlib.Path(r['file']).stem]
    if r['exit'] != 4 or not re.search(r'(postcondition could not be proved|loop invariant could not be proved)',r['output']):
        raise SystemExit(f"FAIL: {r['file']} did not fail a Dafny contract (exit {r['exit']})")
    if not any(f"function {item['function']} [" in loc for loc in r['mapped']):
        raise SystemExit(f"FAIL: {r['file']} failed outside {item['function']}")
    if re.search(r'(resolution/type errors|timed out|ERROR:|unresolved identifier)',r['output']):
        raise SystemExit(f"FAIL: {r['file']} has a tool error")
print(f"BROKEN PASS: {summary['total']}/{summary['total']} executable mutations rejected by Dafny; {summary['seconds']}s")
