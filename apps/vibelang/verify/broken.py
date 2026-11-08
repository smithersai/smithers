#!/usr/bin/env python3
"""Every executable mutation must reach Dafny and fail a contract in its intended function.

  bash verify/broken.sh [NAME ...]   every mutation in mutations.py, or only the named ones

The mutants are generated from src/core/conversation.vibe for this run, under the ignored verify/.checks/.
"""
import hashlib, json, os, pathlib, re, subprocess, sys, tempfile
root=pathlib.Path(__file__).resolve().parent
production=root.parent/'src/core/conversation.vibe'
before=hashlib.sha256(production.read_bytes()).hexdigest()
(root/'.checks').mkdir(exist_ok=True)
mutants=pathlib.Path(tempfile.mkdtemp(prefix='broken-',dir=root/'.checks'))
subprocess.run([sys.executable, str(root/'mutations.py'), str(mutants), *sys.argv[1:]], check=True)
manifest=json.loads((mutants/'manifest.json').read_text())
env={**os.environ, 'CHECK_JOBS':os.environ.get('CHECK_JOBS','2'), 'VERIFY_MUTATION_MANIFEST':str(mutants/'manifest.json')}
p=subprocess.run(['bash',str(root/'check.sh'),str(mutants)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
print(p.stdout, end='')
m=re.search(r'results: (.+/summary.json)',p.stdout)
if not m: raise SystemExit('FAIL: no proof summary; tool/typecheck failure does not count')
summary=json.loads(pathlib.Path(m.group(1)).read_text())
if summary['total'] != len(manifest) or p.returncode != 1: raise SystemExit('FAIL: unexpected mutation count / runner exit')
for r in summary['results']:
    item=manifest[pathlib.Path(r['file']).stem]
    if r['exit'] != 4 or not re.search(r'(postcondition could not be proved|(?:loop|this) invariant could not be proved|assertion might not hold)',r['output']):
        raise SystemExit(f"FAIL: {r['file']} did not fail a Dafny contract (exit {r['exit']})")
    if not any(f"function {item['function']} [" in loc for loc in r['mapped']):
        raise SystemExit(f"FAIL: {r['file']} failed outside {item['function']}")
    if re.search(r'(resolution/type errors|timed out|ERROR:|unresolved identifier)',r['output']):
        raise SystemExit(f"FAIL: {r['file']} has a tool error")
if hashlib.sha256(production.read_bytes()).hexdigest() != before:
    raise SystemExit('FAIL: src/core/conversation.vibe changed during the run')
print(f"BROKEN PASS: {summary['total']}/{summary['total']} executable mutations rejected by Dafny; {summary['seconds']}s")
