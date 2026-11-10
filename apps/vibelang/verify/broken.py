#!/usr/bin/env python3
"""Every executable mutation must reach Dafny and fail a contract in its intended function.

  bash verify/broken.sh [NAME ...]   every mutation in mutations.py, or only the named ones
  bash verify/broken.sh --module src/web/x.vibe   only the mutations of the named production modules

The mutants are generated from src/core/conversation.vibe for this run, under the ignored verify/.checks/.
"""
import hashlib, json, os, pathlib, re, subprocess, sys, tempfile
root=pathlib.Path(__file__).resolve().parent
from sources import production_sources
from mutation_results import validate_rejection
production=production_sources(root.parent)
before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in production}
(root/'.checks').mkdir(exist_ok=True)
mutants=pathlib.Path(tempfile.mkdtemp(prefix='broken-',dir=root/'.checks'))
subprocess.run([sys.executable, str(root/'mutations.py'), str(mutants), *sys.argv[1:]], check=True)
(mutants/'tsconfig.json').write_text(json.dumps({'extends':str(root.parent/'tsconfig.json'),'files':[],'include':[],'exclude':[]}))
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
    try:
        validate_rejection(r, item['function'], item.get('callee_precondition', False))
    except ValueError as error:
        raise SystemExit(f"FAIL: {r['file']}: {error}")
if production_sources(root.parent) != production or any(hashlib.sha256(p.read_bytes()).hexdigest() != digest for p,digest in before.items()):
    raise SystemExit('FAIL: production source changed during the run')
print(f"BROKEN PASS: {summary['total']}/{summary['total']} executable mutations rejected by Dafny; {summary['seconds']}s")
