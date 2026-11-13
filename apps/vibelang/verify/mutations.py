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
cases.extend([("src/core/issueHostDecision.vibe", *case) for case in [
('issues-vip-author','vipDocumentMatches','issueAuthor !== reviewAuthor','false','a VIP review belongs to the issue author'),
('issues-vip-file','vipDocumentMatches','file.filename === path','true','the exact repository document must be changed'),
('issues-vip-removed','vipDocumentMatches','file.status !== "removed"','true','a removed file cannot back a VIP'),
('issues-review-replay','reviewActions','vip === "In review" || vip === (accepted ? "Accepted" : "Declined")','vip === "In review"','a partially completed human review can resume'),
('issues-decline-close','reviewActions','close: allowed && !accepted && state === "open"','close: false','a declined open VIP must still be closed'),
]])
cases.extend([("src/core/conversation.vibe", *case) for case in [
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
# Lane vl-proveall3, landing check (0018): the first mutant of each contract that had none. verify/landing.cjs now
# refuses a contract with no case, unless it is a lemma or restates its table.
cases += [
('src/core/conversation.vibe','lc-run-open-running','runOpen','state === "queued" || state === "running"','state === "queued"','a running action run is still open'),
('src/core/conversation.vibe','lc-review-unanswered','unansweredSpecificationReview','revision: 0','revision: 1','an unanswered review names no revision'),
('src/core/conversation.vibe','lc-acceptance-kept','retainSpecificationAcceptance','  return { ...spec, accepted: { astra: spec.astra, sol: spec.sol, fable: spec.fable, opus: spec.opus } }','  return spec','a specification accepted under keep records its acceptance'),
('src/core/issueGraphDecision.vibe','lc-noted-appends','noted','[...issue.notes, { age: "just now", author, text, event }]','issue.notes','a note appends exactly one entry'),
('src/core/sandboxDecision.vibe','lc-may-start-contributor','mayStart','role === "contributor" || role === "maintainer"','role === "maintainer"','a contributor may start a sandbox'),
('src/core/sandboxDecision.vibe','lc-interval-usage','intervalUsageMilliseconds','return running * elapsed','return running + elapsed','an interval accrues running times elapsed'),
('src/core/sandboxDecision.vibe','lc-accumulate-usage','accumulateUsageMilliseconds','return previous + added','return previous','accrued usage adds the interval'),
('src/core/sandboxDecision.vibe','lc-lease-floor','leaseMilliseconds','if (milliseconds <= 1000) return 1000','if (milliseconds <= 1000) return milliseconds','a lease is at least one second'),
('src/core/toolRefusalDecision.vibe','lc-code-head','codeHead','unit <= 122','unit <= 123','a code starts with a lowercase ASCII letter'),
('src/core/wikiBuildDecision.vibe','lc-rulings-digits','rulingsFrom','[text.slice(at, end), ...rulingsFrom(text, end)]','[text.slice(at, end) + "x", ...rulingsFrom(text, end)]','a ruling is VL- and digits only'),
('src/core/wikiLinkDecision.vibe','lc-folded-prefix-dot','foldedPrefix','count === 0 ? [] :','count === 0 ? ["."] :','a folded path holds no empty or dot segment'),
('src/history/areaDecision.vibe','lc-lower-unit','lowerUnit','unit <= 122','unit <= 123','a lowercase unit is a to z'),
('src/history/bucketDecision.vibe','lc-none-marked','noneMarked','marks.push(false)','marks.push(true)','no commit starts marked'),
('src/history/bucketDecision.vibe','lc-bucket-order-strict','bucketOrder','return bucketed(owned.owner).order','return [...bucketed(owned.owner).order, ...bucketed(owned.owner).order]','buckets come in strict step then commit order'),
('src/history/flowMachine.vibe','lc-begin-phase','begin','phase: "begun"','phase: "authorized"','a run begins unauthorized'),
('src/history/flowMachine.vibe','lc-lawful-once','lawful','run.records <= 1','run.records <= 2','only a fold records more than once'),
('src/history/flowMachine.vibe','lc-signed-role-live','signedRole','mode === "live" ? signed : current','mode === "live" ? current : current','live mode takes the signed role'),
('src/history/trailerDecision.vibe','lc-digit-unit','digitUnit','unit <= 57','unit <= 58','a digit is 0 to 9'),
('src/history/trailerDecision.vibe','lc-name-at-outside','nameAt','mythicalNameSpec(lines[at]!) : ""','mythicalNameSpec(lines[at]!) : "x"','a line outside the message names nothing'),
('src/web/accountViewDecision.vibe','lc-people-toggle','peopleToggleLabel','people === "max" ? "Minimize People"','people === "max" ? "Maximize People"','a maximized People pane offers Minimize'),
('src/web/accountViewDecision.vibe','lc-role-option-new','roleOptionDisabled','return role === "new"','return role === "viewer"','only the new role is not assignable'),
('src/web/actionViewDecision.vibe','lc-mode-command-title','modeCommandTitle','to === "mock" ? "Mock mode"','to === "mock" ? "Live mode"','the mock command is titled Mock mode'),
('src/web/historyViewDecision.vibe','lc-step-marker-muted','stepMarker','status === "run" ? "●" : ""','status === "run" ? "●" : "✓"','a step not reached shows no marker'),
('src/web/historyViewDecision.vibe','lc-blank-or-busy','blankOrBusy','busy || text.trim() === ""','busy && text.trim() === ""','a busy form cannot submit'),
('src/web/issueDecision.vibe','lc-operation-read','issueIsOperation','return action === "read" || action === "new"','return action === "new"','read is an issue operation'),
('src/web/issueDecision.vibe','lc-known-operation','issueKnownAction','return issueIsOperation(action) || action === "retry"','return action === "retry"','every operation is a known action'),
('src/web/issuesViewDecision.vibe','lc-issues-title','issuesTitle','? "Issues" : kind','? "All" : kind','All and Issues are titled Issues'),
('src/web/issuesViewDecision.vibe','lc-cell-fallback','cellText','text === "" ? fallback : text','text === "" ? text : text','an empty cell shows its fallback'),
('src/web/wikiViewDecision.vibe','lc-wiki-status-class','wikiStatusClass','status === "Accepted" ? "sui-badge sui-badge-success"','status === "Accepted" ? "sui-badge sui-badge-outline"','an accepted page has the success badge'),
('src/core/issueHostDecision.vibe','refusal-conflict-invalid','refusalReason','refusal === "key_conflict" ? "invalid" : refusal','refusal === "key_conflict" ? refusal : refusal','a key conflict is the request\'s own fault'),
('src/core/issueHostDecision.vibe','refusal-keeps-reason','refusalReason','refusal === "key_conflict" ? "invalid" : refusal','refusal === "key_conflict" ? "invalid" : "unavailable"','any other refusal keeps its own reason'),
('src/core/issueHostDecision.vibe','issue-write-title-propose','issueWriteRefusal','if (op === "new" || op === "split" || op === "propose") {\n    if (titleBlank) return "title"','if (op === "new" || op === "split" || op === "propose") {\n    if (titleBlank && op !== "propose") return "title"','a proposal needs a title'),
('src/core/issueHostDecision.vibe','issue-write-split-missing','issueWriteRefusal','if (op === "split" && !known) return "missing"','if (op === "split" && known) return "missing"','a split needs the issue it splits'),
('src/core/issueHostDecision.vibe','issue-write-incomplete','issueWriteRefusal','if (op === "propose" && detailsBlank) return "incomplete"','if (op === "propose" && textBlank) return "incomplete"','a proposal needs its example and prior art too'),
('src/core/issueHostDecision.vibe','issue-write-missing','issueWriteRefusal','  if (!known) return "missing"\n  if (op === "comment"','  if (!known && op !== "link") return "missing"\n  if (op === "comment"','every other write needs its issue'),
('src/core/issueHostDecision.vibe','issue-write-empty','issueWriteRefusal','if (op === "comment" && textBlank) return "empty"','if (op === "comment" && titleBlank) return "empty"','a comment needs text'),
('src/core/issueHostDecision.vibe','issue-write-closed','issueWriteRefusal','if (op === "commit" && !open) return "closed"','if (op === "uncommit" && !open) return "closed"','a commitment needs an open issue'),
('worker/budgetDecision.vibe','budget-admit-held','reserveAdmissible','reserved >= 0 && held >= 0 && ceiling > 0','reserved >= 0 && ceiling > 0','admission needs a nonnegative hold'),
('worker/budgetDecision.vibe','budget-admit-ceiling','reserveAdmissible','held >= 0 && ceiling > 0 && over >= 0','held >= 0 && ceiling >= 0 && over >= 0','admission needs a positive ceiling'),
('worker/budgetDecision.vibe','budget-admit-fit','reserveAdmissible','spent + reserved <= 9007199254740991 - ceiling','spent <= 9007199254740991 - ceiling','open reservations count toward the safe range'),
('worker/budgetDecision.vibe','budget-settle-held','settleAdmissible','held >= 0 && held <= reserved && used >= 0','held >= 0 && used >= 0','a hold is part of the open reservations'),
('worker/budgetDecision.vibe','budget-settle-over','settleAdmissible',' && over + used <= 9007199254740991 - ceiling','','the overshoot stays in the safe range'),
('worker/budgetDecision.vibe','budget-settle-used','settleAdmissible','held <= reserved && used >= 0 && ceiling > 0','held <= reserved && ceiling > 0','a charge is nonnegative'),
('worker/budgetDecision.vibe','budget-write-once','writesReservation','return admitted && held === 0','return admitted','a held reservation is not written again'),
('worker/budgetDecision.vibe','budget-outcome-held','admitOutcome','return held === 0 ? "reserved" : "held"','return "reserved"','a repeated admission is held, not reserved'),
('worker/budgetDecision.vibe','budget-outcome-charged','admitOutcome','return recorded ? "charged" : "refused"','return "refused"','a charged reply is not a refusal'),
('worker/budgetDecision.vibe','budget-usable-sign','usableCount','return reported && safe && rounded >= 0','return reported && safe','a negative count is not usable'),
('worker/budgetDecision.vibe','budget-usable-reported','usableCount','return reported && safe && rounded >= 0','return safe && rounded >= 0','an unreported count is not usable'),
('worker/budgetDecision.vibe','budget-call-ceiling','callCeilingUsable','return safe && maximum > 0 && sumSafe','return safe && maximum >= 0 && sumSafe','a call needs a positive ceiling'),
('worker/accountsDecision.vibe','account-signed-in','signedIn','return id !== ""','return id.length > 1','a one-character id is signed in'),
('worker/actionsDecision.vibe','action-post-flow','postFlow','return flow === "vibelang/Post"','return flow.startsWith("vibelang/")','only a post reserves a reply child'),
('worker/actionsDecision.vibe','action-settle-done','agentRunsSettle','return postFlow(flow) && done','return postFlow(flow)','agent runs settle only after the reply is done'),
('worker/actionsDecision.vibe','action-agent-run','agentRun','return actor === "agent"','return actor !== "person"','only the agent\'s runs settle with the reply'),
('src/core/machineDecision.vibe','machine-setup-zero','setupSucceeded','return code === 0','return code <= 0','a negative setup exit is a failure'),
('worker/accountsDecision.vibe','account-open-read','openOperation','return op === "read"','return op === "read" || op === "draft"','a draft is not open to everyone'),
('worker/accountsDecision.vibe','account-open-only','openOperation','return op === "read"','return op !== "comment"','only reading is open'),
('worker/workerDecision.vibe','cursor-leading-zero','cursorAccepted','return /^(?:0|[1-9][0-9]*)$/.test(raw)','return /^[0-9]+$/.test(raw)','a cursor has no leading zero'),
('worker/workerDecision.vibe','body-limit-account','bodyLimit','return 2048','return 4096','an account body is 2 KiB'),
('worker/workerDecision.vibe','body-limit-issues','bodyLimit','return 32768','return 32767','an issue body is 32 KiB'),
('worker/workerDecision.vibe','body-limit-wiki','bodyLimit','return 4194304','return 4194305','a wiki body is 4 MiB'),
('worker/workerDecision.vibe','body-limit-tour','bodyLimit','  return 1024\n}','  return 2048\n}','a tour control is 1,024 units'),
('worker/workerDecision.vibe','body-within-equal','withinBodyLimit','return !(length > maximum)','return length < maximum','a body exactly at the limit is read'),
('worker/workerDecision.vibe','object-method-post','objectMethod','return method === "GET" || method === "POST"','return method === "GET"','an operation is a POST'),
('worker/workerDecision.vibe','cursor-safe','cursorAccepted','value <= 9007199254740991','value <= 9007199254740992','a cursor is a safe integer'),
('worker/accountsDecision.vibe','account-agent-connects','mayConnect','return !agent','return true','an agent session never connects'),
('worker/accountsDecision.vibe','account-person-connects','mayConnect','return !agent','return false','a person may connect'),
('worker/mainLogDecision.vibe','lc-ancestry-starts','ancestryShas','ancestry.add(starts[i]!)','ancestry.add(starts[0]!)','every start is in the ancestry'),
]
cases += web_cases
cases += worker_cases
cases += arm_cases
def source_of(module,fn):
    """The module a case's function lives in: decide and its constructors moved out of conversation.vibe."""
    return 'src/core/decide.vibe' if module=='src/core/conversation.vibe' and fn in {'decide','accepted','refused'} else module
# --cases prints each case's module, function and name as JSON and writes nothing (verify/landing.cjs reads it).
if sys.argv[1:]==['--cases']:
    print(json.dumps([[source_of(module,fn),fn,name] for module,name,fn,*_ in cases])); sys.exit(0)
if len(sys.argv) < 2: raise SystemExit('Usage: mutations.py OUT [NAME ...] [--module src/x.vibe ...] [--check] | --cases')
out=pathlib.Path(sys.argv[1]).resolve()
args=sys.argv[2:]; modules=set(); names=[]
# --check names every case whose production text no longer matches exactly once, and writes no mutant.
check=False; stale=[]
while args:
    arg=args.pop(0)
    if arg=='--check': check=True
    elif arg=='--module':
        if not args: raise SystemExit('--module needs a source path')
        modules.add(args.pop(0))
    else: names.append(arg)

# The manifest and the mutant files are keyed by name: a second case with a used name would silently replace the
# first in a full run (route-wiki, 2026-11-13: 2,879 of 2,880 mutants ran unsharded).
duplicates=sorted({name for _,name,*_ in cases if sum(other==name for _,other,*_ in cases)>1})
if duplicates: raise SystemExit('Duplicate mutation names: '+', '.join(duplicates))
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
    module=source_of(module,fn)
    if modules and module not in modules: continue
    source=(root.parent/module).read_text()
    if selected and name not in selected: continue
    span=function_span(source,fn)
    if not span:
        if check: stale.append(f'{name}: missing function {fn} in {module}'); continue
        raise SystemExit(f'Missing function {fn}')
    start,end=span
    body=source[start:end]
    matches=executable_matches(body,old)
    if len(matches)!=1:
        if check: stale.append(f'{name}: expected 1 executable match in {module} {fn}, found {len(matches)}'); continue
        raise SystemExit(f'{name}: expected 1 executable match, found {len(matches)}')
    if check: continue
    at=matches[0]
    edited=body[:at]+new+body[at+len(old):]
    broken='// Executable mutation: '+claim+'. Contracts are unchanged.\n'+source[:start]+edited+source[end:]
    if contracts(broken)!=contracts(source): raise SystemExit(f'{name}: mutation changed a contract')
    broken,dependencies=flatten_imports(broken,(root.parent/module).parent)
    (out/f'{name}.ts').write_text(lower_spec_functions(broken))
    stage_dependencies(broken,dependencies,out)
    manifest[name]={'source':module,'function':fn,'claim':claim,'before':old,'after':new}
if check:
    if stale: raise SystemExit('Stale mutations:\n'+'\n'.join(stale))
    print(f'{len(cases)} mutation cases each match one executable site'); sys.exit(0)
if modules and not manifest: raise SystemExit('No mutations in: '+', '.join(sorted(modules)))
# Beside the mutants, not among them: the mutant typecheck reads every .ts under OUT.
stage_declarations(root.parent, declarations, out.with_name(out.name+'.declarations'))
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'{len(manifest)} executable-only mutations written to {out}')
