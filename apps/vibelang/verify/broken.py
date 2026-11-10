#!/usr/bin/env python3
"""Generate executable-only mutants; reject them only by a direct own-contract failure.
Every value dependency's original body is freshly proved in the same check invocation.
"""
import hashlib,json,os,pathlib,re,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parent
from sources import production_sources
from mutation_results import validate_rejection
production=production_sources(root.parent)
before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in production}
(root/'.checks').mkdir(exist_ok=True)
mutants=pathlib.Path(tempfile.mkdtemp(prefix='broken-',dir=root/'.checks'))
subprocess.run([sys.executable,str(root/'mutations.py'),str(mutants),*sys.argv[1:]],check=True)
(mutants/'tsconfig.json').write_text(json.dumps({'extends':str(root.parent/'tsconfig.json'),'files':[],'include':[],'exclude':[]}))
manifest=json.loads((mutants/'manifest.json').read_text())
env={**os.environ,'CHECK_JOBS':os.environ.get('CHECK_JOBS','2'),'VERIFY_MUTATION_MANIFEST':str(mutants/'manifest.json')}
output=[]
with subprocess.Popen(['bash',str(root/'check.sh'),str(mutants)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,bufsize=1) as process:
    for line in process.stdout:
        print(line,end='',flush=True);output.append(line)
    code=process.wait()
match=re.search(r'results: (.+/summary.json)',''.join(output))
if not match:raise SystemExit('FAIL: no proof summary; tool/typecheck failure does not count')
summary=json.loads(pathlib.Path(match.group(1)).read_text())
dependencies=[r for r in summary['results'] if not r['mutation']]
for result in dependencies:
    if result['exit']:raise SystemExit(f"FAIL: imported dependency was not proved: {result['file']}")
results=[r for r in summary['results'] if r['mutation']]
if len(results)!=len(manifest) or code!=1:raise SystemExit('FAIL: unexpected mutation count / runner exit')
for result in results:
    item=manifest[pathlib.Path(result['file']).stem]
    try:validate_rejection(result,item['function'])
    except ValueError as error:raise SystemExit(f"FAIL: {result['file']}: {error}")
if production_sources(root.parent)!=production or any(hashlib.sha256(p.read_bytes()).hexdigest()!=digest for p,digest in before.items()):
    raise SystemExit('FAIL: production source changed during the run')
print(f"BROKEN PASS: {len(results)}/{len(results)} executable mutations rejected by Dafny; {len(dependencies)} dependency modules freshly proved; {summary['seconds']}s")
if not sys.argv[1:]:
    subprocess.run([sys.executable, str(root/'runtime_broken.py')], check=True)
