#!/usr/bin/env python3
"""Fresh lsc generation + Dafny verification. Never trusts saved .dfy files."""
import atexit, concurrent.futures, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
from sources import production_sources, require_proved, proof_dependencies, VERIFY, dafny_keywords, dafny_name
from proof_additions import add_proof_steps, insertion_names
from declarations import stage as stage_declarations, copied_imports, declared_imports
from spec_functions import lower as lower_spec_functions
from proof_diagnostics import read_diagnostics
import proof_cache
from mutation_targets import POSTCONDITIONS, ASSERTIONS, INVARIANTS, postcondition_line, case_assertion_line, invariant_line, time_limit, wall_limit
ROOT=pathlib.Path(__file__).resolve().parent
APP=pathlib.Path(os.environ.get("VIBELANG_VERIFY_ROOT", str(ROOT.parent))).resolve()
if len(sys.argv)>1:
 sources=[pathlib.Path(arg).resolve() for arg in sys.argv[1:]]
 selected=[]
 for candidate in sources:
  if not candidate.exists(): raise SystemExit(f'Not found: {candidate}')
  if not candidate.is_relative_to(APP): raise SystemExit(f'Source must be inside {APP}')
  selected += [candidate] if candidate.is_file() else sorted(p for p in candidate.rglob('*.ts') if not p.name.endswith(('.vibe.ts','.d.ts')) and not any(x in {'.tools','node_modules','.checks'} for x in p.relative_to(candidate).parts))
 selected=list(dict.fromkeys(selected))
 source=sources[0] if len(sources)==1 else APP
else:
 source=APP
 selected=production_sources(APP)
started=time.monotonic()
# A run owns its artifacts. It reuses an earlier passing proof of a module only under a key over everything that proof
# read and the tools that checked it (proof_cache.py); anything else is proved in this run.
checks=APP/'verify'/'.checks'; checks.mkdir(parents=True,exist_ok=True); run=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=checks))
# The proof sources strictly typecheck separately. Keep identical compiler options while
# excluding unrelated application files from each ts-morph generation project.
proof_sources=run/'source'
proof_sources.mkdir()
(proof_sources/'tsconfig.json').write_text(json.dumps({'extends':str(APP/'tsconfig.json'),'files':[],'include':[],'exclude':[]}))
# LemmaScript reads TypeScript. A `.vibe` module written in its verifiable subset is TypeScript syntax, so the run
# proves an exact `.ts` copy of its text, staged with this run's artifacts; reports name the `.vibe` file and line.
# The one change is each `spec function`, written as `export function` on the same line (spec_functions.py).
# A type-only import of a module that is not TypeScript syntax (`import type { Message } from "./main.vibe"`) reads the module's emitted declaration instead,
# `x.vibe.d.ts` beside the copy, so a proved module can name the types of a module outside the subset (declarations.py).
declarations={}
def proof_bytes(path):
 data=path.read_bytes()
 expected=dependency_hashes.get(path.resolve())
 if expected is not None and hashlib.sha256(data).hexdigest()!=expected:
  raise SystemExit(f'Proof input changed after dependency discovery: {path}')
 return data
def stage_imports(original, staged):
 # An import of a proved module is read by LemmaScript for its contracts only: `./x.vibe` resolves to this `x.vibe.ts` copy.
 text=proof_bytes(original).decode()
 for spec in declared_imports(text, original.parent):
  declarations[(staged.parent/spec).with_name(pathlib.Path(spec).name+'.d.ts')]=(original.parent/spec).resolve()
 for spec in copied_imports(text, original.parent):
  dep=(original.parent/spec).resolve(); copy=(staged.parent/spec).with_name(pathlib.Path(spec).name+'.ts')
  if not dep.exists(): raise SystemExit(f'Missing proof import {spec} of {original}')
  require_proved(dep, PRODUCTION)
  copy.parent.mkdir(parents=True,exist_ok=True)
  if not copy.exists():
   copy.write_text(lower_spec_functions(proof_bytes(dep).decode())); stage_imports(dep,copy)
PRODUCTION=production_sources(APP)
manifest_path=pathlib.Path(os.environ['VERIFY_MUTATION_MANIFEST']).resolve() if os.environ.get('VERIFY_MUTATION_MANIFEST') else None
manifest=json.loads(manifest_path.read_text()) if manifest_path else {}
mutant_files=set(selected) if manifest_path else set()
roots=[APP/item['source'] for item in manifest.values()] if manifest_path else selected
dependencies,dependency_hashes=proof_dependencies(roots,PRODUCTION)
selected=list(dict.fromkeys([*selected,*dependencies]))
shown={}
files=[]
for original in selected:
 if original.suffix=='.vibe':
  staged=run/'source'/original.relative_to(APP).with_suffix('.ts')
  staged.parent.mkdir(parents=True,exist_ok=True); staged.write_text(lower_spec_functions(proof_bytes(original).decode()))
  shown[staged]=original; files.append(staged)
  stage_imports(original, staged)
 else: files.append(original)
if not files: raise SystemExit(f'No annotated production modules or TypeScript files under {source}')
stage_declarations(APP, declarations, run/'declarations')
config=APP/('.verify-'+run.name+'.config.json')
config.write_text(json.dumps({'string-semantics':'javascript-utf16','dafny-library':'local','proof-dir':str(run.relative_to(APP)),'run-log':False}))
atexit.register(lambda: config.unlink(missing_ok=True))
# A mutant is always proved: its rejection is the point. Every other staged module may reuse an identical earlier proof.
reusable={staged:origin for staged,origin in shown.items() if staged not in mutant_files}
cache_keys=proof_cache.keys(APP,run,reusable,json.loads(config.read_text()),APP==ROOT.parent,proof_cache.tools_digest(ROOT/'.tools',ROOT.parents[2]/'packages/lemmascript'),proof_cache.harness_digest()) if reusable else {}

commands=[]
def command(args, cwd, wall_seconds=180):
 t=time.monotonic()
 try:
  p=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=wall_seconds)
  commands.append({'argv':args,'cwd':str(cwd),'exit':p.returncode,'seconds':round(time.monotonic()-t,3),'last_lines':p.stdout.splitlines()[-8:]})
  return p.returncode,p.stdout
 except subprocess.TimeoutExpired as e:
  out=e.stdout or b''
  return 124,(out.decode(errors='replace') if isinstance(out,bytes) else out)+f'\nERROR: wall timeout {wall_seconds}s\n'
 except OSError as e: return 127,str(e)+'\n'

def verify(item):
 idx,ts=item; is_mutation=ts in mutant_files; key=None if is_mutation else cache_keys.get(ts)
 stored=proof_cache.load(APP,key) if key else None
 if stored: return {**stored['result'],'seconds':0.0,'cached':stored['run'],'key':key}
 t=time.monotonic(); original=ts.read_bytes(); lines=original.decode().splitlines(); origin=shown.get(ts,ts)
 # Report function declarations and contract lines even for extraction failures.
 # The hash is the original's, which the run rechecks at completion; a staged copy differs only by spec_functions.lower.
 origin_bytes=origin.read_bytes()
 head=r'^\s*(?:export )?(?:spec )?function\s+(\w+)'
 funcs=[(n+1,re.search(head,s).group(1)) for n,s in enumerate(origin_bytes.decode().splitlines()) if re.search(head,s)]
 loc=', '.join(f'{origin}:{n} function {name}' for n,name in funcs) or str(origin)
 work=run/ts.relative_to(APP).parent; work.mkdir(parents=True,exist_ok=True)
 dfy=work/ts.with_suffix('.dfy').name
 # Preseed a fresh generated-only destination, never reuse neighboring proof files.
 dfy.write_text('')
 code,out=command([str(ROOT/'.tools/bin/lsc'),'gen','--backend=dafny',f'--config={config}',str(ts)],ROOT)
 if code==0 and dfy.with_suffix('.dfy.gen').exists():
  shutil.copyfile(dfy.with_suffix('.dfy.gen'),dfy)
 if code==0:
  text=dfy.read_text() if dfy.exists() else ''
  proof_source=origin.relative_to(APP).as_posix()
  if is_mutation:
   if ts.parent != manifest_path.parent: raise SystemExit('Proof additions only apply to generated mutants')
   proof_source=manifest[ts.stem]['source']
  raw=text
  # The checked induction steps belong to this app, not another project that happens to use its file names.
  text=add_proof_steps(raw,proof_source) if APP == ROOT.parent else raw
  if text != raw:
   dfy.write_text(text)
   dfy.with_suffix('.proof.json').write_text(json.dumps({'source':proof_source,'insertions':insertion_names(proof_source),'raw_sha256':hashlib.sha256(raw.encode()).hexdigest(),'checked_sha256':hashlib.sha256(text.encode()).hexdigest()}))
  marked=[]
  before=''
  for n,line in enumerate(lines):
   m=re.search(r'^\s*(?:export )?function\s+(\w+)',line)
   if m:
    if VERIFY.search(before): marked.append(m.group(1))
    before=''
   elif line.lstrip().startswith('//') or not line.strip(): before+='\n'+line
   else: before=''
  for name in marked:
   if not re.search(r'\b(?:function|method)\s+'+re.escape(dafny_name(name,KEYWORDS))+r'(?:<[^>(]*>)?\(',text):
    code=2;out+=f'ERROR: marked function {name} was not emitted\n'
  if code: dfy.write_text(text);text='' 
  if not re.search(r'\b(?:ensures|assert)\b',text):
   code=2;out+='ERROR: no proof obligations emitted (selective mode / missing annotations)\n'
  else:
   flags=['--unicode-char:false','--allow-deprecation'] if 'string-semantics=javascript-utf16' in text else ['--unicode-char:true']
   if 'Std.' in text: flags.append('--standard-libraries')
   if is_mutation:
    if ts.parent != manifest_path.parent: raise SystemExit('Mutation symbol filter only applies to generated mutants')
    target=manifest[ts.stem]['function']
    flags.extend(['--filter-symbol',target])
    if ts.stem in ASSERTIONS:
     case, clause = ASSERTIONS[ts.stem]
     line = case_assertion_line(text, target, case, clause)
     flags.extend(['--isolate-assertions','--filter-position',':'+str(line)])
    elif ts.stem in INVARIANTS:
     line=invariant_line(text,target,INVARIANTS[ts.stem])
     flags.extend(['--isolate-assertions','--filter-position',':'+str(line)])
    elif ts.stem in POSTCONDITIONS:
     line=postcondition_line(text,target,POSTCONDITIONS[ts.stem])
     flags.extend(['--isolate-assertions','--filter-position',':'+str(line)])
   # Every assertion in Markdown composition, the full conversation and decide relations, and the replay importing their
   # contracts, is checked, without a symbol/position filter.
   isolate = not is_mutation and origin in {APP/'src/core/conversation.vibe',APP/'src/core/decide.vibe',APP/'src/core/replayDecision.vibe',APP/'src/web/markdownDecision.vibe'}
   if isolate: flags.append('--isolate-assertions')
   # The isolated relations' wall limit only stops a hung solver; each obligation keeps its own solver limit.
   limit=time_limit(ts.stem,is_mutation,proof_source)
   # A single isolated file may use two cores; two file workers each use one solver core.
   c,o=command([str(ROOT/'.tools/bin/dafny'),'verify','--cores','2' if isolate and jobs == 1 else '1','--verification-time-limit',str(limit),'--error-limit','1' if is_mutation else '0','--log-format',f'csv;LogFileName={work / (ts.stem + chr(46) + chr(99) + chr(115) + chr(118))}',*flags,str(dfy)],work,wall_limit(isolate,is_mutation,limit))
   code=c;out+=o
 if hashlib.sha256(original).hexdigest() != initial_hashes[ts]:
  code=2;out+='ERROR: source changed after strict typechecking started\n'
 if ts.read_bytes() != original or (lower_spec_functions(origin.read_text()).encode() if origin != ts else origin.read_bytes()) != original:
  code=2;out+='ERROR: source changed during verification\n'
 elapsed=time.monotonic()-t
 # Dafny emits generated locations. Identify enclosing generated symbol, then
 # print its original TS declaration; retain exact generated diagnostic too.
 diagnostics=read_diagnostics(out,dfy.read_text() if dfy.exists() else '',dfy,funcs,KEYWORDS)
 mapped=[f"{origin}:{d['source_line']}: function {d['function']} [{d['symbol']}; generated line {d['line']}]"
         for d in diagnostics if d['function'] is not None]
 log=work/(ts.stem+'.output.log');log.write_text(out)
 return {'sha256':hashlib.sha256(origin_bytes).hexdigest(),'file':str(origin),'exit':code,'seconds':round(elapsed,3),'locations':loc,'mapped':list(dict.fromkeys(mapped)),'output':out,'log':str(log),'dfy':str(dfy),'diagnostics':diagnostics,'mutation':is_mutation,'key':key}

KEYWORDS=dafny_keywords()
initial_hashes={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}

tc_code,tc_output=command(['node',str(ROOT/'typecheck.cjs'),*[str(p) for p in files]],ROOT)
print(tc_output,end='')
if tc_code:
 (run/'typecheck.log').write_text(tc_output)
 raise SystemExit(tc_code)

jobs=int(os.environ.get('CHECK_JOBS','1'))
if not 1<=jobs<=8: raise SystemExit('CHECK_JOBS must be 1..8')
results=[]
def report(r):
 results.append(r)
 print(f"{'PASS' if r['exit']==0 else 'FAIL'} {r['locations']} "+(f"(reused: proved in {r['cached']})" if r.get('cached') else f"({r['seconds']:.3f}s)"))
 if r['exit']:
  for m in r['mapped']: print(m)
  print(r['output'],end='')
 else:
  for line in r['output'].splitlines():
   if 'finished with' in line: print('  '+line)
 sys.stdout.flush()
# An imported module's contracts may be assumed while proving a caller only after its own body was freshly proved.
# Dependency checks run sequentially so a two-core isolated relation never overlaps another Dafny process.
dependency_items=[item for item in enumerate(files) if manifest_path and item[1] not in mutant_files]
for item in dependency_items:
 result=verify(item);report(result)
 if result['exit']:break
else:
 remaining=[item for item in enumerate(files) if item not in dependency_items]
 with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
  for result in pool.map(verify,remaining):report(result)
for path,digest in dependency_hashes.items():
 if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
  raise SystemExit(f'FAIL: proof dependency changed during verification: {path}')
# A late edit or newly marked module invalidates the whole production receipt too.
if len(sys.argv)==1 and production_sources(APP) != selected:
 raise SystemExit('FAIL: production source set changed during verification')
for r in results:
 original=pathlib.Path(r['file'])
 if not original.exists() or hashlib.sha256(original.read_bytes()).hexdigest() != r['sha256']:
  r['exit']=2; r['output']+='ERROR: source changed before verification completed\n'
  print('FAIL: source changed before verification completed: '+r['file'])
# Store a module's pass only when every non-mutant module of the run passed, so no stored proof leans on a failed one.
if all(r['exit']==0 for r in results if not r['mutation']):
 for r in results:
  if r.get('key'): proof_cache.save(APP,r['key'],r,run)
summary={'directory':str(source),'reused':sum(bool(r.get('cached')) for r in results),'seconds':round(time.monotonic()-started,3),'passed':sum(r['exit']==0 for r in results),'total':len(results),'jobs':jobs,'dependencies':[str(p) for p in dependencies],'inputs':{str(p):h for p,h in dependency_hashes.items()},'results':results,'commands':commands}
(run/'summary.json').write_text(json.dumps(summary,indent=2))
print(f"{summary['passed']}/{len(results)} files verified ({summary['reused']} reused) in {summary['seconds']:.3f}s; results: {run/'summary.json'}")
raise SystemExit(0 if summary['passed']==len(results) else 1)
