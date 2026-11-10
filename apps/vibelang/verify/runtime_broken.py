#!/usr/bin/env python3
"""Reject adapter mutants with actual assertion failures in the real regression suites."""
import hashlib, json, pathlib, shutil, subprocess, sys, tempfile
from runtime_mutations import CASES

app = pathlib.Path(__file__).resolve().parent.parent
selected = [case for case in CASES if not sys.argv[1:] or case[0] in sys.argv[1:]]
if len(selected) != (len(sys.argv[1:]) if sys.argv[1:] else len(CASES)):
    raise SystemExit('Unknown or duplicate runtime mutant')
(app/'verify/.checks').mkdir(exist_ok=True)
source_hashes = {path: hashlib.sha256((app/path).read_bytes()).hexdigest() for _, path, *_ in selected}
receipts = []
with tempfile.TemporaryDirectory(prefix='runtime-', dir=app/'verify/.checks') as temporary:
    stage = pathlib.Path(temporary)
    for name in ['src', 'worker', 'test']:
        shutil.copytree(app/name, stage/name, ignore=shutil.ignore_patterns('*.d.vibe.ts', '*.js', '*.map'))
    for path in app.glob('*.json'):
        shutil.copy2(path, stage/path.name)
    for name in ['vite.config.ts', 'quickjs.vite.ts']:
        # Its package path is anchored to the production config, not to the temporary tree.
        text = (app/name).read_text().replace('new URL("../../packages/smithers/agent/harness/package.json", import.meta.url).pathname', repr(str((app/'../../packages/smithers/agent/harness/package.json').resolve())))
        (stage/name).write_text(text)
    (stage/'node_modules').symlink_to(app/'node_modules', target_is_directory=True)
    for name, source, test, old, new, expected in selected:
        original = (app/source).read_text()
        if original.count(old) != 1:
            raise SystemExit(f'{name}: mutation must match exactly once')
        # A passing baseline distinguishes a mutant's failure from a broken fixture or tool.
        for mutated in [False, True]:
            (stage/source).write_text(original.replace(old, new) if mutated else original)
            output = stage/(name+('-mutant' if mutated else '-baseline')+'.json')
            command = ['pnpm', 'exec', 'vitest', 'run', test, '--reporter=json', '--outputFile='+str(output)]
            result = subprocess.run(command, cwd=stage, capture_output=True, text=True, timeout=300)
            if not output.exists():
                raise SystemExit(f'{name}: tool failed before a test report\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}')
            report = json.loads(output.read_text())
            assertions = [a for suite in report['testResults'] for a in suite['assertionResults']]
            failures = [a for a in assertions if a['status'] == 'failed']
            if not mutated:
                if result.returncode or not assertions or failures:
                    raise SystemExit(f'{name}: production baseline failed: {failures}')
            else:
                own = [a for a in failures if expected in a['fullName'] and any('AssertionError' in message for message in a['failureMessages'])]
                if result.returncode != 1 or not own:
                    raise SystemExit(f'{name}: no intended behavioral assertion rejected the mutant: {failures}')
                receipts.append({'name': name, 'source': source, 'sha256': source_hashes[source], 'exit': result.returncode, 'assertions': [a['fullName'] for a in own]})
                print(f'RUNTIME REJECT {name}: {own[0]["fullName"]}', flush=True)
        (stage/source).write_text(original)
if any(hashlib.sha256((app/path).read_bytes()).hexdigest() != digest for path, digest in source_hashes.items()):
    raise SystemExit('Production source changed during runtime mutations')
destination = app/'verify/.checks/runtime-summary.json'
destination.write_text(json.dumps({'results': receipts}, indent=2)+'\n')
print(f'RUNTIME PASS: {len(receipts)}/{len(selected)} adapter mutations rejected; receipts: {destination}')
