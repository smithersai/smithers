"""Docker integration check for the production executor's fixed command boundary."""
import json, subprocess, urllib.request, urllib.error, http.client, time, uuid
name = 'tutorial-check-' + uuid.uuid4().hex[:8]
image = 'smithers-tutorial-executor:test'
subprocess.run(['docker','build','-f','apps/tutorial-executor/Dockerfile','-t',image,'.'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['docker','run','--rm','-d','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--tmpfs','/workspace:rw,uid=10001,gid=10001,size=128m','--tmpfs','/tmp:rw,uid=10001,gid=10001,size=32m','-p','127.0.0.1::3001',image],check=True,stdout=subprocess.DEVNULL)
try:
    port = subprocess.check_output(['docker','port',name,'3001/tcp'],text=True).strip().rsplit(':',1)[1]
    endpoint='http://127.0.0.1:'+port
    for _ in range(50):
        try: urllib.request.urlopen(endpoint+'/health'); break
        except (urllib.error.URLError, http.client.HTTPException): time.sleep(.1)
    def call(action, **values):
        req=urllib.request.Request(endpoint+'/execute',json.dumps(dict(action=action,**values)).encode(),{'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=40) as response: return response.status,json.load(response)
        except urllib.error.HTTPError as error: return error.code,json.load(error)
    status,start=call('snapshot'); assert status==200 and len(start['files'])==6
    _,baseline=call('test'); assert baseline['code']!=0 and '# fail 2' in baseline['stdout'], baseline
    status,_=call('apply',files={'package.json':'{}'}); assert status==422
    status,_=call('apply',files={'../../etc/passwd':'bad'}); assert status==422
    status,_=call('apply',files={'src/hello.ts':'x'*65537}); assert status==422
    fixed='export function greet(name: string | null): string { return `Hello, ${name || "world"}!` }\n'
    status,_=call('apply',files={'src/hello.ts':fixed}); assert status==200
    _,passed=call('test'); assert passed['code']==0 and '# pass 4' in passed['stdout']
    status,commit=call('commit',message='Fix greeting',idempotencyKey='test-run-123'); assert status==200 and commit['parent']==start['base']
    status,again=call('commit',message='Fix greeting',idempotencyKey='test-run-123'); assert status==200 and again==commit
    status,diff=call('diff',base=start['base']); assert status==200 and '+export function greet' in diff['patch']
    status,_=call('apply',files={'src/hello.ts':'export function greet(name: string | null): string { process.exit(0) }\n'})
    _,early=call('test'); assert early['code']!=0 and 'did not all complete' in early['stderr']
    status,_=call('apply',files={'src/hello.ts':fixed,'src/hello.test.ts':'import { test } from "node:test"; import {writeFileSync} from "node:fs"; test("cannot mutate repository",()=>writeFileSync("README.md","tampered"));\n'})
    _,denied=call('test'); assert denied['code']!=0 and 'ERR_ACCESS_DENIED' in denied['stdout']
    print('Executor passed: baseline failure, fixed tests, real commit/diff, retry idempotency, path/size restrictions, early exit and test write denial.')
finally:
    subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
