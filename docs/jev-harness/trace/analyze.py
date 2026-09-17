import json, sys, collections
d = sys.argv[1] if len(sys.argv) > 1 else '.'
def short(path):
    return path
print("### ROUTES")
for l in open(f'{d}/requests.ndjson'):
    o=json.loads(l)
    if o.get('marker'): print('== step',o['step'],o['note']); continue
    rb=o.get('resBody')
    keys = list(rb.keys()) if isinstance(rb,dict) else (f'list[{len(rb)}]' if isinstance(rb,list) else str(rb)[:40])
    req=o.get('reqBody')
    rq = (json.dumps(req)[:140]) if req is not None else ''
    q=o.get('query','')
    if q and len(q)>60: q=q[:60]+'…'
    print(f"{o.get('seq'):>4} {o['method']:7} {o['path']}{('?'+q) if q else ''} -> {o.get('status')} {o.get('resContentType','')[:22]} keys={keys} {rq}")
print("### EVENTS")
counts=collections.Counter()
for l in open(f'{d}/events.ndjson'):
    o=json.loads(l)
    if o.get('marker'): print('== step',o['step']); continue
    if 'sseLine' in o: print('   ', o['path'], 'line:', o['sseLine'][:60]); continue
    if o.get('streamEnd'): print('   ', o['path'], 'END'); continue
    e=o['event']
    p=e.get('payload', e)
    d_=p.get('data', p.get('properties'))
    dk=list(d_.keys()) if isinstance(d_,dict) else d_
    t=p.get('type')
    counts[(o['step'],t)]+=1
    if counts[(o['step'],t)]<=2 or t and ('session' in t or 'permission' in t or 'message' in t or 'todo' in t):
        print(f"   {o['path']} {t} dir={e.get('directory','')[-20:] if 'directory' in e else ''} data={dk}")
