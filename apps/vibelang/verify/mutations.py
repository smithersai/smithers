#!/usr/bin/env python3
"""Checked-in broken copies differ from production only in executable code. --check never writes."""
import json, pathlib, re, sys
root=pathlib.Path(__file__).resolve().parent
source=(root.parent/'src/core/conversation.ts').read_text()
cases=[
('apply-advance','apply','seq: event.seq }','seq: event.seq + 1 }','seq changes by at most one; next event advances exactly once'),
('apply-ignore','apply','if (event.seq !== conversation.seq + 1) return conversation','if (event.seq === conversation.seq + 1) return conversation','ignore every event except the next'),
('apply-order','apply','seq: event.seq,\n        clientId: event.clientId,','seq: conversation.seq,\n        clientId: event.clientId,','entries remain strictly ordered'),
('apply-bound','apply','seq: event.seq,\n        clientId: event.clientId,','seq: event.seq + 1,\n        clientId: event.clientId,','entry sequence is bounded by conversation sequence'),
('apply-client-id','apply','event.text === "" || event.clientId === "" || hasClientId(conversation.entries, event.clientId)','event.text === "" || event.clientId === "" || (hasClientId(conversation.entries, event.clientId) && false)','nonempty person client ids are unique'),
('apply-phase','apply','agent: "working", replying: event.id','agent: "working", replying: ""','working iff reply id is nonempty for admitted reply starts'),
('apply-open-owner','apply','author: "agent",','author: "person",','only the current agent reply can be unfinished'),
('apply-one-open','apply','if (conversation.agent === "working" || hasEntryId(conversation.entries, event.id)) return next','if (hasEntryId(conversation.entries, event.id)) return next','at most one entry is unfinished'),
('apply-open-exists','apply','return { ...next, entries, agent: "working", replying: event.id }','return { ...next, entries: entries.map((entry) => ({ ...entry, done: true })), agent: "working", replying: event.id }','working implies an unfinished entry exists'),
('apply-person-id','apply','clientId: event.clientId,','clientId: "",','nonempty person ids remain nonempty for admitted posts'),
('apply-prefix','apply','const entries = [...conversation.entries, entry]\n      //@ assert forall','const entries = [entry, ...conversation.entries]\n      //@ assert forall','append preserves every existing entry'),
('apply-delta-done','apply','{ ...entry, text: entry.text + event.text }','{ ...entry, text: entry.text + event.text, done: true }','delta preserves done flags and the open reply'),
('apply-agent-name','apply','name: AGENT_NAME,','name: "wrong",','started reply carries the agent name and appends one entry'),
('is-replying','isReplying','conversation.agent === "working" && conversation.replying === id && id !== ""','conversation.agent === "working"','exact reply predicate'),
('has-client-id','hasClientId','if (entries[i]!.clientId === clientId) return true','if (entries[i]!.clientId === clientId) return false','exact client-id lookup'),
('has-client-id-skip','hasClientId','i++','i += 2','lookup loop bounds and processed-prefix invariant'),
('post-skip','post','i++','i += 2','post loop bounds and processed-prefix invariant'),
('accepted','accepted','return { ok: true, event }','return { ok: true, event: { ...event, seq: event.seq + 1 } }','accepted constructor preserves event'),
('refused','refused','return { ok: false, refusal }','const wrong: Refusal = "busy"\n  return { ok: false, refusal: wrong }','refused constructor preserves reason'),
('decide-next','decide','const seq = conversation.seq + 1','const seq = conversation.seq + 2','every accepted event is the next one'),
('decide-start','decide','      if (intent.id === "") return refused("not-replying")\n      if (hasEntryId(conversation.entries, intent.id)) return refused("duplicate")\n      return accepted({ type: "ReplyStarted"','      return accepted({ type: "ReplyStarted"','accepted start has a fresh, nonempty reply id'),
('decide-busy','decide','if (conversation.agent === "working")','if (false)','accepted start requires no working reply'),
('decide-client-id','decide','intent.clientId === "" || hasClientId(conversation.entries, intent.clientId)','hasClientId(conversation.entries, intent.clientId) && false','accepted post has a nonempty client id and no existing matching client id'),
('has-entry-id','hasEntryId','if (entries[i]!.id === id) return true','if (entries[i]!.id === id) return false','exact entry-id lookup'),
('apply-entry-id','apply','hasClientId(conversation.entries, event.clientId) || hasEntryId(conversation.entries, event.id)) return next','hasClientId(conversation.entries, event.clientId)) return next','entry ids stay unique whatever event arrives'),
('apply-empty-client','apply','event.text === "" || event.clientId === "" || hasClientId','event.text === "" || hasClientId','person entries never carry an empty client id'),
('decide-entry-id','decide','if (text.length > MAX_TEXT) return refused("too-long")\n      if (hasEntryId(conversation.entries, intent.id)) return refused("duplicate")','if (text.length > MAX_TEXT) return refused("too-long")','an accepted post has a fresh entry id'),
('decide-blank','decide','if (text === "")','if (false)','accepted post has nonempty text'),
('decide-limit','decide','if (text.length > MAX_TEXT)','if (false)','accepted post obeys the text limit'),
('post-duplicate','post','if (client.pending[i]!.clientId === clientId) return client','if (client.pending[i]!.clientId === clientId) return { ...client, pending: [...client.pending, { clientId, text: trimmed, error: "" }] }','pending client ids remain unique; retry is unchanged'),
('post-size','post','pending: [...client.pending, { clientId, text: trimmed, error: "" }]','pending: [...client.pending, { clientId, text: trimmed, error: "" }, { clientId: clientId + "!", text: trimmed, error: "" }]','post adds at most one pending entry'),
('post-prefix','post','pending: [...client.pending, { clientId, text: trimmed, error: "" }]','pending: [...client.pending.map((waiting) => ({ ...waiting, error: "wrong" })), { clientId, text: trimmed, error: "" }]','post preserves the existing pending prefix'),
('post-frame','post','return { ...client, pending: [...client.pending','return { ...client, conversation: { ...client.conversation, seq: client.conversation.seq + 1 }, gap: !client.gap, pending: [...client.pending','post preserves conversation and gap'),
('fail-post-frame','failPost','...client,','...client, conversation: { ...client.conversation, seq: client.conversation.seq + 1 }, gap: !client.gap,','failure preserves conversation and gap'),
('fail-post-size','failPost','pending: client.pending.map((waiting) => waiting.clientId === clientId ? { ...waiting, error: reason === "" ? "failed" : reason } : waiting),','pending: [...client.pending.map((waiting) => waiting.clientId === clientId ? { ...waiting, error: reason === "" ? "failed" : reason } : waiting), { clientId, text: "", error: "" }],','failure preserves pending length'),
('fail-post-fields','failPost','{ ...waiting, error: reason === "" ? "failed" : reason } : waiting','{ ...waiting, clientId: "wrong", text: "wrong", error: "wrong" } : { ...waiting, error: "wrong" }','failure preserves ids/text and unmatched entries, and marks matching errors exactly'),
('receive-stale','receive','if (event.seq <= seq) return client','if (false) return client','old events leave the whole client unchanged'),
('receive-gap','receive','return client.gap ? client : { ...client, gap: true }','return client','future event marks a gap'),
('resume-gap','resume','return client.gap ? { ...client, gap: false } : client','return client','resume clears gap'),
('resume-frame','resume','{ ...client, gap: false }','{ ...client, conversation: { ...client.conversation, seq: client.conversation.seq + 1 }, pending: [], gap: false }','resume preserves conversation and pending'),
]
manifest={}
check='--check' in sys.argv
for name,fn,old,new,claim in cases:
    match=re.search(r'^(?:export )?function '+fn+r'\(',source,re.M)
    if not match: raise SystemExit(f'Missing function {fn}')
    start=match.start(); following=re.search(r'^(?:export )?function \w+\(',source[match.end():],re.M)
    end=match.end()+following.start() if following else len(source)
    body=source[start:end]
    if body.count(old)!=1: raise SystemExit(f'{name}: expected 1 executable match, found {body.count(old)}')
    broken='// Executable mutation: '+claim+'. Contracts are unchanged.\n'+source[:start]+body.replace(old,new)+source[end:]
    contracts=lambda text:[line for line in text.splitlines() if line.lstrip().startswith('//@')]
    if contracts(broken)!=contracts(source): raise SystemExit(f'{name}: mutation changed a contract')
    path=root/'broken'/f'{name}.ts'
    if check:
        if not path.exists() or path.read_text()!=broken: raise SystemExit(f'{name}: fixture drift; regenerate with python3 verify/mutations.py')
    else:
        path.parent.mkdir(exist_ok=True);path.write_text(broken)
    manifest[name]={'function':fn,'claim':claim,'before':old,'after':new}
path=root/'broken/manifest.json'
if check:
    if json.loads(path.read_text())!=manifest: raise SystemExit('Manifest drift')
    if {p.stem for p in path.parent.glob('*.ts')} != set(manifest): raise SystemExit('Unexpected broken files')
else: path.write_text(json.dumps(manifest,indent=2)+'\n')
print(f'{len(manifest)} executable-only mutations '+('match production' if check else 'written'))
