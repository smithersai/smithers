#!/usr/bin/env python3
"""Write executable mutations of the production module, generated at run time and never committed.

  python3 verify/mutations.py OUT [NAME ...]

writes OUT/<name>.ts for every case below (or only the named ones) and OUT/manifest.json. Each copy is the text of
src/core/conversation.vibe, which LemmaScript reads as TypeScript, changed in executable code only: every `//@`
contract and assertion stays byte-identical, and each case must match exactly once inside its function.
"""
import json, pathlib, re, sys
from mutation_edit import executable_matches, flatten_imports, function_span
from declarations import stage as stage_declarations, parses_as_typescript, value_imports
from spec_functions import lower as lower_spec_functions
declarations={}
from sources import production_sources, require_proved
root=pathlib.Path(__file__).resolve().parent
from extended_mutations import cases as extended_cases
from web_mutations import cases as web_cases
from worker_mutations import cases as worker_cases
from arm_mutations import cases as arm_cases
# These mutate native adapters and are rejected by behavioral tests, not Dafny.
# The full verify:broken gate runs both registries and reports their counts separately.
from runtime_mutations import CASES as runtime_cases
# The mutation cases: name, function, production text, mutated text, the claim the mutation breaks.
cases=[
('wiki-edits-stale','applyWikiEdits','if (event.seq !== state.seq + 1) return state','if (event.seq === state.seq + 1) return state','a stale wiki observation changes nothing'),
('wiki-edits-pages','applyWikiEdits','return { seq: event.seq, pages: event.pages }','return { seq: event.seq, pages: state.pages }','a fresh wiki observation replaces the projected pages'),
('wiki-least-role','leastRole','case "action": case "sandbox": case "triage": case "wiki": return "contributor"','case "action": case "sandbox": case "triage": case "wiki": return "viewer"','wiki editing names contributor as its least role'),
('wiki-editor-stale','currentWikiEditor','request === activeRequest','request !== activeRequest','a stale editor response cannot close the current edit'),
('wiki-policy-save','wikiPolicyAction','if (op === "save") return "merge"','if (op === "save") return "wiki"','only a maintainer uses Save'),
('wiki-person-decide','decide','if (intent.id !== "" && !isReplying(conversation, intent.id)) return refused("not-replying")','if (!isReplying(conversation, intent.id)) return refused("not-replying")','a person can open a wiki page while the agent is idle'),
('wiki-person-apply','apply','if ((event.id !== "" && !isReplying(conversation, event.id)) || event.url === "") return next','if (!isReplying(conversation, event.id) || event.url === "") return next','a person opening is projected by every client'),
('wiki-person-url','decide','return accepted({ type: "PaneOpened", seq, id: intent.id, url: intent.url })','return accepted({ type: "PaneOpened", seq, id: intent.id, url: "wrong" })','the accepted pane event preserves the requested page'),
('apply-advance','apply','seq: event.seq }','seq: event.seq + 1 }','seq changes by at most one; next event advances exactly once'),
('apply-ignore','apply','if (event.seq !== conversation.seq + 1) return conversation','if (event.seq === conversation.seq + 1) return conversation','ignore every event except the next'),
('apply-order','apply','seq: event.seq,\n        clientId: event.clientId,','seq: conversation.seq,\n        clientId: event.clientId,','entries remain strictly ordered'),
('apply-bound','apply','seq: event.seq,\n        clientId: event.clientId,','seq: event.seq + 1,\n        clientId: event.clientId,','entry sequence is bounded by conversation sequence'),
('apply-client-id','apply','event.text === "" || event.clientId === "" || hasClientId(conversation.entries, event.clientId)','event.text === "" || event.clientId === "" || (hasClientId(conversation.entries, event.clientId) && false)','nonempty person client ids are unique'),
('apply-phase','apply','agent: "working", replying: event.id','agent: "working", replying: ""','working iff reply id is nonempty for admitted reply starts'),
('apply-open-owner','apply','author: "agent",','author: "person",','only the current agent reply can be unfinished'),
('apply-one-open','apply','if (conversation.agent === "working" || hasEntryId(conversation.entries, event.id) || !canReplyTo(conversation.entries, event.inReplyTo)) return next','if (hasEntryId(conversation.entries, event.id) || !canReplyTo(conversation.entries, event.inReplyTo)) return next','at most one entry is unfinished'),
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
('decide-start','decide','      if (intent.id === "") return refused("not-replying")\n      if (hasEntryId(conversation.entries, intent.id)) return refused("duplicate")\n      if (!canReplyTo(conversation.entries, intent.inReplyTo)) return refused("not-replying")\n      return accepted({ type: "ReplyStarted"','      return accepted({ type: "ReplyStarted"','accepted start has a fresh, nonempty reply id'),
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
('decide-reply-target','decide','if (!canReplyTo(conversation.entries, intent.inReplyTo)) return refused("not-replying")','if (false) return refused("not-replying")','accepted reply targets an existing unanswered person post'),
('decide-reply-correlation','decide','inReplyTo: intent.inReplyTo','inReplyTo: intent.id','accepted reply carries exactly the requested target'),
('can-reply-person','canReplyTo','entries[i]!.author === "person" && entries[i]!.id === id','entries[i]!.id === id','a reply target must be a person post'),
('can-reply-answered','canReplyTo','if (entries[i]!.author === "agent" && entries[i]!.inReplyTo === id) return false','if (false) return false','a post with any existing reply cannot receive a second'),
('can-reply-missing','canReplyTo','return found','return true','a missing post cannot be answered'),
('apply-reply-correlation','apply','inReplyTo: event.inReplyTo','inReplyTo: event.id','the projected reply preserves its target'),
('retry-post-frame','retryPost','...client, pending:','...client, gap: !client.gap, pending:','retry preserves conversation and gap'),
('retry-post-clear','retryPost','error: ""','error: "failed"','retry clears only the matching pending failure'),
('apply-restart-text','apply','{ ...entry, text: "" }','{ ...entry, text: entry.text }','a restart empties the streaming reply and keeps every entry'),
('decide-restart-guard','decide','      if (!isReplying(conversation, intent.id)) return refused("not-replying")\n      return accepted({ type: "ReplyRestarted"','      return accepted({ type: "ReplyRestarted"','an accepted restart names the reply that streams'),
('tour-entry','tourEntry','inReplyTo: "", author: "agent"','inReplyTo: id, author: "agent"','a tour is an agent entry that answers no post'),
('apply-tour-phase','apply','replying: event.id, agent: "working" }','replying: "", agent: "working" }','a started tour is the entry that streams'),
('apply-tour-busy','apply','if (conversation.agent === "working" || hasEntryId(conversation.entries, event.id)) return next','if (hasEntryId(conversation.entries, event.id)) return next','a tour starts only while no reply streams'),
('apply-tour-end-guard','apply','if (!isTouring(conversation, event.id)) return next','if (false) return next','only the running tour ends'),
('apply-tour-end-idle','apply','agent: "idle", replying: "" }','agent: "working", replying: "" }','ending the tour stops the agent'),
('apply-tour-end-text','apply','{ ...entry, done: true } : entry)\n      return { ...next, entries: ended','{ ...entry, done: true, text: "" } : entry)\n      return { ...next, entries: ended','ending the tour keeps what the agent said'),
('apply-pane','apply','return { ...next, pane: event.url }','return { ...next, pane: conversation.pane }','an opened page shows in the pane'),
('apply-pane-guard','apply','if ((event.id !== "" && !isReplying(conversation, event.id)) || event.url === "") return next','if (event.url === "") return next','only the agent that streams moves the pane'),
('is-tour','isTour','&& entries[i]!.inReplyTo === "") return true',') return true','a tour answers no post'),
('is-touring','isTouring','return isTour(conversation.entries, id)','return true','only a tour entry is a running tour'),
('decide-tour-busy','decide','if ("working" === conversation.agent) return refused("busy")','if (false) return refused("busy")','a second tour waits while the agent works'),
('decide-tour-id','decide','return accepted({ type: "TourStarted", seq, id: intent.id })','return accepted({ type: "TourStarted", seq, id: intent.id + "x" })','a started tour carries the requested id'),
('decide-end-tour','decide','case "EndTour":\n      if (!isTouring(conversation, intent.id)) return refused("not-replying")','case "EndTour":\n      if (!isReplying(conversation, intent.id)) return refused("not-replying")','a person ends only a tour, never a reply'),
('decide-pane-guard','decide','if (intent.id !== "" && !isReplying(conversation, intent.id)) return refused("not-replying")\n      if (intent.url','if (false) return refused("not-replying")\n      if (intent.url','only the agent that streams opens a page'),
('decide-pane-empty','decide','if (intent.url === "") return refused("empty")','if (false) return refused("empty")','an opened page has a url'),
('role-rank', 'rank', 'case "viewer": return 0', 'case "viewer": return 1', 'viewer has zero rank'),
('least-role', 'leastRole', 'case "read": case "ask": case "tour": return "viewer"', 'case "read": case "ask": case "tour": return "new"', 'public actions remain public'),
('people-minimum', 'leastRole', 'case "people": case "issue": case "comment": return "new"', 'case "people": return "viewer"\n    case "issue": case "comment": return "new"', 'People and role-event access require a signed identity'),
('role-minimum', 'may', 'rank(role) >= rank(leastRole(action))', 'rank(role) > rank(leastRole(action))', 'the minimum role is admitted'),
('role-lookup', 'roleOf', 'if (roles[i]!.id === id) return roles[i]!.role', 'if (roles[i]!.id === id) return "new"', 'newest grant determines current role'),
('role-first', 'ungranted', 'if (roles[i]!.id === id) return false', 'if (roles[i]!.id === id) return true', 'explicit demotion suppresses automatic promotion'),
('role-other', 'otherMaintainer', 'return false', 'return true', 'the last maintainer has no independent peer'),
('role-actor-forward', 'canGrant', 'roleOf(roles, by)', '"maintainer"', 'the host forwards the actual actor role'),
('grant-empty', 'grantPolicy', 'id === "" || role === "viewer"', 'role === "viewer"', 'unnamed people cannot receive grants'),
('grant-viewer', 'grantPolicy', 'id === "" || role === "viewer"', 'id === ""', 'viewer is unsigned, never granted'),
('grant-bootstrap-actor', 'grantPolicy', 'by === "" && ledgerEmpty', 'ledgerEmpty', 'bootstrap is a server operation'),
('grant-bootstrap-empty', 'grantPolicy', 'by === "" && ledgerEmpty', 'by === ""', 'bootstrap only enters an empty ledger'),
('grant-bootstrap-role', 'grantPolicy', 'ledgerEmpty && role === "maintainer"', 'ledgerEmpty', 'bootstrap names the initial maintainer'),
('grant-participant', 'grantPolicy', 'by === id && role === "community" && fresh', 'role === "community" && fresh', 'participation promotes only its own identity'),
('grant-participation-role', 'grantPolicy', 'by === id && role === "community" && fresh', 'by === id && fresh', 'participation grants community only'),
('grant-participation-once', 'grantPolicy', 'by === id && role === "community" && fresh', 'by === id && role === "community"', 'participation promotes once and respects explicit demotion'),
('grant-person', 'grantPolicy', 'if (by === "" || current === role)', 'if (current === role)', 'manual grant requires a signed identity'),
('grant-nochange', 'grantPolicy', 'if (by === "" || current === role)', 'if (by === "")', 'unchanged roles are refused'),
('grant-self', 'grantPolicy', 'if (by === id && rank(role) >= rank(current)) return false', 'if (false) return false', 'self promotion is forbidden'),
('grant-maintainer', 'grantPolicy', 'if (by !== id && actor !== "maintainer") return false', 'if (false) return false', 'only a maintainer grants another person'),
('grant-last', 'grantPolicy', 'if (current === "maintainer" && !other) return false', 'if (false) return false', 'the final maintainer cannot be removed'),
('decide-role-guard', 'decide', 'if (!canGrant(conversation.roles, intent.id, intent.by, intent.role, intent.mode))', 'if (false)', 'the sequencer enforces role grant admission'),
('decide-self-grant', 'decide', 'if (!canGrant(conversation.roles, intent.id, intent.by, intent.role, intent.mode)) return refused("forbidden")', 'if (intent.id === "" || intent.role === "viewer" || (intent.by !== intent.id && !canGrant(conversation.roles, intent.id, intent.by, intent.role, intent.mode))) return refused("forbidden")', 'a person cannot promote themselves through the sequencer'),
('decide-authorize-narrow', 'decide', 'if (!may(roleOf(conversation.roles, intent.by), intent.action)) return refused("forbidden")', 'if ((intent.action === "merge" || intent.action === "settings" || intent.action === "roles") && !may(roleOf(conversation.roles, intent.by), intent.action)) return refused("forbidden")', 'every action, not only the maintainer ones, is authorized at its least role'),
('decide-grant-event', 'decide', 'by: intent.by, role: intent.role, mode: intent.mode', 'by: intent.by, role: "maintainer", mode: intent.mode', 'the numbered grant carries the decided role'),
('cangrant-self-current', 'canGrant', 'grantPolicy(id, by, roleOf(roles, id),', 'grantPolicy(id, by, "maintainer",', 'a person can only lower their own current role'),
('steprun-drop-step', 'stepRun', ': [...run.steps, { key, name, attempt, state, started: at, at }]', ': run.steps', 'a new engine step is appended to its run'),
('steprun-passed', 'stepRun', 'return { ...run, state: "running", steps', 'return { ...run, state: "passed", steps', 'a step keeps its run running'),
('apply-action-actor', 'apply', 'actor: event.actor, state: "queued"', 'actor: "", state: "queued"', 'a requested run records who asked for it'),
('apply-walkthrough-guard', 'apply', 'if (!isTouring(conversation, event.id) || event.step < 1', 'if (event.step < 1', 'only the running tour drives the walkthrough'),
('decide-request-copies', 'decide', 'door: intent.door, actor: intent.actor, at: intent.at', 'door: intent.door, actor: "", at: intent.at', 'the requested run event names the requesting actor'),
('decide-trace-open', 'decide', '      if (!hasOpenRun(runsOf(conversation), intent.id)) return refused("not-replying")\n      return accepted({ type: "ActionStep"', '      return accepted({ type: "ActionStep"', 'a step is numbered only for an open run'),
('decide-settle-open', 'decide', '      if (!hasOpenRun(runsOf(conversation), intent.id)) return refused("not-replying")\n      return accepted({ type: "ActionSettled"', '      return accepted({ type: "ActionSettled"', 'a settlement is numbered only for an open run'),
('has-run-found', 'hasRun', 'if (runs[i]!.id === id) return true', 'if (runs[i]!.id === id) return false', 'a run with the id is found'),
('has-open-run-state', 'hasOpenRun', 'if (runs[i]!.id === id && runOpen(runs[i]!.state)) return true', 'if (runs[i]!.id === id) return true', 'a settled run is not open'),
('decide-request-fresh', 'decide', 'if (hasRun(runsOf(conversation), intent.id)) return refused("duplicate")', 'if (false) return refused("duplicate")', 'a requested run has a fresh id'),
('decide-action-guard', 'decide', 'if (!may(roleOf(conversation.roles, intent.by), intent.action))', 'if (false)', 'the sequencer refuses actions below their least role'),
('apply-role', 'apply', 'role: event.role, blocked: event.mode === "person"', 'role: "viewer", blocked: event.mode === "person"', 'the numbered grant preserves the role'),
]
cases=[('src/core/conversation.vibe', *case) for case in cases] + extended_cases
cases.extend([("src/core/conversation.vibe", *case) for case in [
('issues-vip-author','vipDocumentMatches','issueAuthor !== reviewAuthor','false','a VIP review belongs to the issue author'),
('issues-vip-file','vipDocumentMatches','file.filename === path','true','the exact repository document must be changed'),
('issues-vip-removed','vipDocumentMatches','file.status !== "removed"','true','a removed file cannot back a VIP'),
('issues-review-replay','reviewActions','vip === "In review" || vip === (accepted ? "Accepted" : "Declined")','vip === "In review"','a partially completed human review can resume'),
('issues-decline-close','reviewActions','close: allowed && !accepted && state === "open"','close: false','a declined open VIP must still be closed'),
('issues-stale','applyIssues','if (event.seq !== state.seq + 1) return state','if (false) return state','stale observations cannot replace the projection'),
('issues-content','applyIssues','items: event.items','items: state.items','the next observation projects exactly GitHub records'),
('issues-commit-role','issuePermission','return may(role, issuePolicyAction(op))','return true','only maintainers commit work or review VIPs'),
('issues-new-vip','issuePolicyAction','if (op === "propose" || op === "draft") return "vip"','if (op === "propose" || op === "draft") return "issue"','a new identity cannot propose a VIP'),
('issues-commit-identity','setCommitment','...issue, task:','...issue, number: issue.number + 1, task:','a task keeps its GitHub identity'),
('issues-commit-assignee','setCommitment','assignee: committed ? assignee : ""','assignee: ""','a committed task names the assigned worker'),
('issues-uncommit','setCommitment','task: committed ? "Queued" : ""','task: "Queued"','uncommit restores a plain issue'),
('issues-decline','declineVip','state: "closed"','state: issue.state','a declined VIP is closed'),
('issues-review-task','approveVip','...issue, vip:','...issue, task: "Queued", vip:','accepting a VIP does not silently commit work'),
]])
cases += [
('src/core/conversation.vibe','wiki-editor-page','currentWikiEditor','page === activePage','page !== activePage','an editor response must name its current page'),
('src/core/conversation.vibe','wiki-editor-empty','currentWikiEditor','page !== ""','true','an empty page never identifies an editor'),
('src/core/conversation.vibe','wiki-policy-read','wikiPolicyAction','if (op === "read") return "read"','if (op === "read") return "wiki"','wiki reads remain public'),
('src/core/conversation.vibe','wiki-policy-propose','wikiPolicyAction','return "wiki"','return "merge"','contributors can propose and draft'),
('src/core/conversation.vibe','wiki-role-gate','wikiPermission','return may(role, wikiPolicyAction(op))','return may(role, "read")','wiki writes retain the exact least role'),
('src/core/conversation.vibe','wiki-edits-seq','applyWikiEdits','seq: event.seq, pages: event.pages','seq: state.seq, pages: event.pages','the next wiki observation advances its cursor'),
('src/core/wikiDecision.vibe','wiki-person-only','wikiSubmissionAllowed','kind === "person"','true','an agent can never submit a wiki review'),
('src/core/wikiDecision.vibe','wiki-agent-draft','wikiSubmissionAllowed','operation === "draft"','false','an agent can draft for review'),
('src/core/wikiDecision.vibe','wiki-agent-read','wikiSubmissionAllowed','operation === "read"','false','an agent can read'),
('src/core/protocolDecision.vibe','wiki-account-route','accountRoute','path === "/api/wiki" || ','','wiki uses the account credential boundary'),
]
cases += [
('src/core/sandboxDecision.vibe', 'meter-rollover-early', 'meterStep', 'if (end === boundary) return', 'if (end >= boundary - 1) return', 'a month opens only at its first millisecond'),
('src/core/sandboxDecision.vibe', 'meter-rollover-carry', 'meterStep', 'month: boundary, used: prior }', 'month: boundary, used: charged }', 'a new month starts from its own usage, never the old month\'s'),
('src/core/sandboxDecision.vibe', 'meter-step-count', 'meterStep', 'intervalUsageMilliseconds(count, ', 'intervalUsageMilliseconds(1, ', 'every running sandbox accrues the interval'),
]
cases += web_cases
cases += worker_cases
cases += arm_cases
if len(sys.argv) < 2: raise SystemExit('Usage: mutations.py OUT [NAME ...] [--module src/x.vibe ...]')
out=pathlib.Path(sys.argv[1]).resolve()
args=sys.argv[2:]; modules=set(); names=[]
while args:
    arg=args.pop(0)
    if arg=='--module':
        if not args: raise SystemExit('--module needs a source path')
        modules.add(args.pop(0))
    else: names.append(arg)

selected=set(names)
unknown=selected-{name for module,name,*_ in cases}
if unknown: raise SystemExit('Unknown mutations: '+', '.join(sorted(unknown)))
contracts=lambda text:[line for line in text.splitlines() if line.lstrip().startswith('//@')]
out.mkdir(parents=True,exist_ok=True)
# A mutant reads its imports' contracts as axioms, so each import must itself be a proved production module.
production=production_sources(root.parent)
def stage_dependencies(text,dependencies,out):
    """Copy every `.vibe` file `text` imports for values, and theirs in turn, flattened beside it as `name.vibe.ts`.
    A module imported only with `import type` that is not TypeScript syntax gets its emitted declaration instead
    (declarations.py)."""
    pending,seen=[(text,dependencies)],{}
    while pending:
        importer,found=pending.pop()
        values={pathlib.Path(spec).name for spec in value_imports(importer)}
        for spec,path in found.items():
            if spec not in values and not parses_as_typescript(path):
                declarations.setdefault(out/f'{spec}.d.ts',path)
                continue
            require_proved(path,production)
            if spec in seen:
                if seen[spec]!=path: raise SystemExit(f'two imports share the file name {spec}')
                continue
            seen[spec]=path
            copied,more=flatten_imports(path.read_text(),path.parent)
            (out/f'{spec}.ts').write_text(lower_spec_functions(copied))
            pending.append((copied,more))

manifest={}
for module,name,fn,old,new,claim in cases:
    if module=='src/core/conversation.vibe' and fn in {'decide','accepted','refused'}: module='src/core/decide.vibe'
    if modules and module not in modules: continue
    source=(root.parent/module).read_text()
    if selected and name not in selected: continue
    span=function_span(source,fn)
    if not span: raise SystemExit(f'Missing function {fn}')
    start,end=span
    body=source[start:end]
    matches=executable_matches(body,old)
    if len(matches)!=1: raise SystemExit(f'{name}: expected 1 executable match, found {len(matches)}')
    at=matches[0]
    edited=body[:at]+new+body[at+len(old):]
    broken='// Executable mutation: '+claim+'. Contracts are unchanged.\n'+source[:start]+edited+source[end:]
    if contracts(broken)!=contracts(source): raise SystemExit(f'{name}: mutation changed a contract')
    broken,dependencies=flatten_imports(broken,(root.parent/module).parent)
    (out/f'{name}.ts').write_text(lower_spec_functions(broken))
    stage_dependencies(broken,dependencies,out)
    manifest[name]={'source':module,'function':fn,'claim':claim,'before':old,'after':new}
if modules and not manifest: raise SystemExit('No mutations in: '+', '.join(sorted(modules)))
# Beside the mutants, not among them: the mutant typecheck reads every .ts under OUT.
stage_declarations(root.parent, declarations, out.with_name(out.name+'.declarations'))
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'{len(manifest)} executable-only mutations written to {out}')
