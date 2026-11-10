// Node reads this proof-tool entry directly; VibeLang supplies the original-source ESTree AST.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const app = path.resolve(__dirname, '..');
const decision = path.join(app, 'wiki/decisions/0018-proofs.md');
function scan(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e =>
    e.isDirectory() ? scan(path.join(folder,e.name)) : e.name.endsWith('.vibe') ? [path.join(folder,e.name)] : []);
}
const shellBoundaries = {
  'src/core/roles.vibe': 'Post author formatting delegates to the proved identityDecision; role grants delegate to the existing proved policy. Session signature/expiry checks and Effect service execution remain host/library boundaries.',
  'src/surfaces/session.vibe': 'Private atomic settings and credential-origin decoding are OS/FileSystem/Schema boundaries, exercised over real files and a faulty permissions service. No proof of filesystem permissions, atomic rename or JSON decoding is claimed.',
  'src/surfaces/signin.vibe': 'GitHub device transport, interval persistence, session validation and logout run inside journaled native Actions. GitHub responses, clocks, HTTP, private settings and Effect execution remain tested host boundaries, not formal proofs.',
  'src/surfaces/sessionFlow.vibe': 'Delegates mutations and polling/waits to the existing native SQLite flow host, Action, Poll and Sleep; bounded outcome-only observations and SDK execution remain host/library boundaries.',

  'src/web/historyApp.vibe': 'Calls proved role thresholds, live role reset, open-epic membership and plan fields (flowMachine), and historyDecision for response guards, one outline read at a time, the page merge, read offsets, hash reads and the exact scalar frame of every arm. Host boundaries: the Foldkit message match and the spread of each frame over the model, the hash regexps (regexp.ts), Schema decoding and command execution.',
  'src/history/LiveMythical.vibe': 'Calls proved accepted/refused/unavailable HTTP outcome mapping. Native HTTP/SSE and JSON/Schema codecs remain boundaries.',

  'worker/Reply.vibe': 'Threads the proved Reply start/compose/settle model through actual Actions and calls the proved complete event router/completion choices; invalid telemetry retains prior valid spend and cannot publish success. Native SDK payload projection and effect orchestration remain unproved; native safe-integer observations, AgentAction internal event replay, DoneText/provider decoding and date/prompt formatting remain host boundaries.',
  'worker/Objects.vibe': 'The live dispatcher uses the proved scan/attempt/done transition; only a successful engine start writes a mark. Intent/storage codecs, engine execution, alarms and runtime composition remain host boundaries.',
  'src/web/theatre.vibe': 'Calls the proved selector, speech action, audio identity, outcome and focus-index policies. DOM geometry and native number subtraction, speech APIs, persisted JSON decoding and host execution remain boundaries.',
  "src/history/Sequencer.vibe": "Calls the proved history machine, rank validation, capacity guard and foldTarget, the proved stackDecision plan step, pair-safe fold title and first epic by title, and the followDecision replay cut. Decodes storage/replay/follow/bootstrap with redacted errors. The `Mythical:` trailer regexp (regexp.ts), locking, store-before-publish and PubSub delivery remain runtime boundaries.",
  'src/history/schemas.vibe': 'Rank bounds call proved validRank/validRanks; Schema safe-integer and JSON decoding remain runtime boundaries (unsafe-integer.ts, json-codec.ts).',
  'worker/HistoryObject.vibe': 'Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved.',
  'src/web/main.vibe': 'Calls proved six-field surface/tour projections, pane/media/response guards, scroll/focus policies and conversation transitions. Full Model composition, account/People transitions, numeric counter domains, retry selection and command execution remain unproved.',
  'src/web/viewport.vibe': 'Calls the proved pause, scroll, follow and key steps in screenDecision. Host boundaries: DOM reads and writes, touch lookup and the PageUp distance (Math.floor).',
  'src/core/mockReplies.vibe': 'First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction).',
  'src/core/wire.vibe': 'Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts).',
  'src/core/LiveFactory.vibe': 'HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts).',
  "src/surfaces/commands.vibe": "Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation, outcome/error mapping and every argument decision: plan kind and target, history reads, unknown epic, page total, issue detail and resume fields, write refusal text, wiki default page, run-wait settlement and action failure text. Schema decoding, stream execution, id generation, the key-sanitizing regexp and output formatting remain boundaries.",
  'src/surfaces/backend.vibe': 'Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved.',
  'src/web/startup.vibe': 'Calls proved startupDecision choices for preference, authoritative role list and saved tutorial controls. URL parsing, storage effects, storage-denial fallback, resource loading and Foldkit startup remain host boundaries.',
  'src/web/historyStartup.vibe': 'Calls proved startupDecision preference and authoritative role-list/default choices. Storage, URL parsing, resource loading and Foldkit execution remain host boundaries.',
  'src/web/modeSwitch.vibe': 'Calls the proved opposite-mode, mode name and label choices; HtmlBuilder rendering and native navigation remain host boundaries.',
  'src/web/backend.vibe': 'Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior.',
  'worker/Http.vibe': 'Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries.',
  'worker/Budget.vibe': 'Admission and settlement run the proved reserve/settle kernel inside the semaphore, so concurrent admissions cannot pass the limit. The semaphore itself, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts); the workerd suite exercises twenty concurrent admissions.',
  'src/core/sandboxMeter.vibe': 'Each interval\'s accrual and month rollover is the proved meterStep (sandboxDecision.vibe). UTC month boundaries (Date.UTC), bucket storage and the interval loop\'s termination remain host boundaries.',
  'src/core/flows.vibe': 'Tour threads active/ready/one-speaker/terminal state; terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Private visit/hold counters use proved exact BigInt increments; first-visit, paused-wait, requested seek and reading-clock step choices are proved. Full optional restored-cursor composition, Flow execution, word tokenization, docs regexp and reply-id slice remain unproved.',
  "worker/Sequencer.vibe": "Calls proved conversation/append/start decisions, retained-log replay, ordered model-context selection, the proved sequencerDecision attempt, restart count, finish plan (the reply ends as exactly the model text), settle step, tour speech and entry lookup, and the followDecision replay cut. Stored events are decoded before replay. Locking, log writes before publish, PubSub delivery, event ids from numbers and the read snapshot Set (readonly-set.ts) remain runtime boundaries.",
  'src/history/flows.vibe': 'Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020).',
  'src/history/roles.vibe': 'may, leastRole, peopleOnly and standing are proved in flowMachine.vibe; this module re-exports them and builds the role tables from them (0020).',
};
const boundaries = {
  "src/core/issueHostDecision.vibe": "Proved request-key admission (exactly /^[A-Za-z0-9-]{1,100}$/), GitHub failure classification and retry codes, the HTTP status of every refusal, the unwritten mark (a first execution refused before any write), the agent accept and decline refusal, task and VIP reading, the receipt-gated Accepted projection, the advancing revision, resumable operations and resume status, the agent's choice label both ways, and timeline event text (0018 third-lane batch 6).",
  "src/core/mockFactoryDecision.vibe": "Proved the scripted agent's exact reply precedence, the draft outcome, actor journal keys (injective over id and kind), the restored id counter, the replay cursor and the live tail (0018 third-lane batch 8); the mock accounts' self-grant rule and fixture logins (batch 10).",
  "src/core/wikiPageDecision.vibe": "Proved first page by id, the editable rule, the designs alias, page links, the longest named id (earliest among ties), the first id with a prefix, the agent's request precedence, the wiki unwritten mark, the fixture repository's verdict and review numbers, and each refusal's HTTP status (0018 third-lane batch 9).",
  "src/core/actionRunDecision.vibe": "Proved the reply child id and test, which runs a start runs and a cancel stops, the settled state and result, and when a start, a history action and a tour settle (0018 third-lane batch 11).",
  "src/core/sandboxMockDecision.vibe": "Proved the mock device's command precedence and the current lease (0018 third-lane batch 12).",
  "src/history/seedDecision.vibe": "Proved first area naming a scope, which queue entries count, exact join precedence (regenerated docs, revert, landed entry, new), the last sentence end that fits and the note cut (else a short first sentence, else dropped), the evidence paragraph step (a line wraps only onto an open paragraph) and how a fold reads back a stored title (0018 third-lane batch 4).",
  "src/actions/catalogDecision.vibe": "Proved exact least role (tours public; approve and fold maintainer; else contributor) and input kind for each flow tag (0018 third-lane batch 3).",
  "src/core/tourDecision.vibe": "Proved exact docs-path admission (no scheme, host, query, dot segment or //), running tour and reply id (0018 third-lane batch 2).",
  "src/history/pageDecision.vibe": "Proved page start, exact page count (none past the end, at most a page) and the pair-safe search clip (0018 third-lane batch 2); exact per-key totals over a Map (a key never seen is absent and totals 0), the stack order (epic then rank, or rank alone if an epic is absent), the open filter and the search predicate (batch 7).",
  "src/core/sequencerDecision.vibe": "Proved exact restart count by recursive prefix measure, model attempt, restarts needed, first-match entry index, finish plan whose restart/append reproduces exactly the model text, idempotent settle step, tour speech separator and tour settlement (0018 third-lane batch 1).",
  "src/core/followDecision.vibe": "Proved replay cut (the later of cursor and last replayed number) and strict freshness, used by both sequencers so a live event at or below the replay is never sent twice (0018 third-lane batch 1).",
  "src/history/stackDecision.vibe": "Proved exact plan step precedence (amend, empty, too-long, insert, open-epic, append), UTF-16 surrogate predicates, the pair-safe cut, the fold title (unchanged when it fits, else cut between characters with \"\u2026\" within the limit) and the first epic by title (0018 third-lane batch 1).",
  'src/core/identityDecision.vibe': 'Proved exact unsigned guest, authenticated person and authenticated agent post labels. Signature verification and session persistence supplying the fields remain host/library boundaries (0028).',

  'src/web/modelDecision.vibe': 'Web update decisions: account failure text and retry routing, sign-in and role gates, people pane sizing, account-change and grant detection, stale-response fences for actions, issues and wiki, monotone actions clock, bounded slash highlight, sandbox minute notices and the running transition; proved (0018 batch 21).',
  'worker/replyProgressDecision.vibe': 'Complete event-kind routing, ignored/non-text identity transitions, closed bounded token invariant, zero base/exact sum recurrence, native-validation admission flags, text/retry/failure frames, latched malformed telemetry and completion precedence; proved over the established integer domain. Native Number.isSafeInteger observations and provider/DoneText decoding are host boundaries (safe-usage-integer.ts).',
  'worker/liveDispatchDecision.vibe': 'Proved exact scan cursor and first-unmarked selection, no skipped unmarked post, terminal idempotency and one engine attempt per invocation, including refusal; storage-mark truth and engine execution are host boundaries.',
  'src/web/theatreDecision.vibe': 'Proved exact target selectors, speech cancellation/pause/resume/replacement priority, no duplicate speech on redraw, audio identity invalidation, bounded outcome labels and keyboard focus wrapping; native speech, DOM and persistence remain host boundaries.',
  'src/web/startupDecision.vibe': 'Proved explicit query precedence, preference writes, authoritative role-list membership/default, saved tutorial controls and the opposite-mode switch; native URL/storage effects and storage-failure fallback remain host boundaries.',
  'src/web/viewDecision.vibe': 'Proved refusal/status labels, entry display flags, send/transition choices, sandbox pane/response/action guards and media failure/motion choices. Rendering, asset lookup and actual DOM execution remain host boundaries.',
  "src/surfaces/commandDecision.vibe": "Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping, and every command argument decision (plan kind/target, history reads, unknown epic, total, issue detail/resume, write refusal, wiki page, run wait, action failure; 0018 third-lane batch 1). UUID generation, streams and rendering are in commands.vibe.",
  "src/core/sequenceDecision.vibe": "Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; worker/Reply.vibe executes the model on the turns chosen.",
  "src/core/sandboxDecision.vibe": "Proved sandbox integer kernel, iterative runtime traversals and quantified source-position contracts: exact running counts, interval usage and accumulation, remaining allowance, monotone clocks, refusal precedence, first-match lookup, identity fences and transition frames (0024). Its inputs are whole safe integers: sandboxMeter.vibe normalizes Date and IEEE-754 values before calling it.",
  'src/core/mockDecision.vibe': 'Exact keyword membership, first-match priority and fallback; proved for normalized prompts.',
  'src/core/protocolDecision.vibe': 'Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved.',
  'src/web/historyDecision.vibe': 'Proved history-page decisions (0020): late-outline, commit and matches response guards, one outline read at a time, the page merge with exact splice and one page per epic, page read offsets, hash and epic reads, the search guard and the exact scalar frame of every update arm.',
  'src/web/screenDecision.vibe': 'Exact six-field surface/tour projections, escape, palette, scroll, focus, stream and announcement decisions, and the viewport steps: a pause or a scroll off the bottom takes the next intent, every event raises it by at most one, only the newest intent on an active page scrolls. Finite coordinates are exact reals. Not proved: IEEE-754 subtraction (real-rounding.ts), nonfinite DOM coordinates, and an intent past 2^53-1 native events.',
  'src/history/mythical.vibe': 'Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts).',
  "src/history/flowMachine.vibe": "Proved exact history authorization/run ordering, shared role thresholds, HTTP status/outcome mapping, plan validation/field initialization, open-epic membership and append prefix, signatures and labels, with executable mutations (0020). Removal order in toggleEpic is not stated (annotation-lambda.ts); membership is exact. Codecs live in LiveMythical.vibe, page/model transitions in historyApp.vibe and engine replay in flows.vibe, each noted there.",
  'src/web/issueDecision.vibe': 'Every decision the issues screen makes over plain values carries proved contracts: remembered operations, the role gate, step errors, actions, card and list loads, when a projection or data reply applies, the assignee after a change, recovery, failure and request text, and the parent; 107 executable mutations. `issues.vibe` and the `update` arms read data, build requests and run Commands, which remain host boundaries.',
  'src/web/paneDecision.vibe': 'The sandbox and wiki-editor arms of `update` as proved functions over plain data: the start action, the loaded sandbox, its notice and month warning, the wiki edit types, submit plan, begin and failure steps and error text; 52 executable mutations. main.vibe interprets the commands; Foldkit dispatch remains a host boundary.',
  'src/web/tourDecision.vibe': 'The tour controls and the event stream connection as proved functions over plain values: pause and resume, back, skip, sound, a late tour end, what a failed tour keeps, auto start and reconnection; 89 executable mutations. `update` reads the model and builds Commands, which remain host boundaries.',
  'src/web/updateDecision.vibe': 'The web update\'s decisions as proved functions over plain values: Escape\'s ladder, the applied event and the step after every message; 83 executable mutations. `update` reads the model and builds Commands, which remain host boundaries.',
  'src/core/decide.vibe': 'The sequencer: every accepted event is the next; a role grant is accepted exactly when canGrant admits it and an authorization exactly when the actor\'s role may take the action, every action, both refused forbidden; accepted action requests copy every field for a fresh id; steps and settlements are numbered exactly for an open run. Imported conversation.vibe contracts are axioms here and proved there.',
  'src/core/conversation.vibe': 'Production state machine: exact entry/role frames, action-run frames and partial walkthrough frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain.',
  'src/core/issueGraphDecision.vibe': 'Proved (0018 fifth lane): from a forest, every issue write the host accepts leads to a forest: positive numbers, every parent the root or an issue, and no issue its own ancestor at any number of links, so no sequence of writes creates a cycle; the bounded first-match ancestor walk, created numbers above every number, and which edit changes a parent. GitHub owns live edges after the same canLinkIssues check.',
  'src/core/replayDecision.vibe': 'Proved (0018 fifth lane): replayLog is exactly the left fold of apply over the log; the live step recordedConversation applies and appends an accepted event, changes nothing on a refusal, and keeps the conversation equal to the replay of its log. Store durability and order, locking and PubSub delivery remain runtime boundaries.',
  'src/history/replayDecision.vibe': 'Proved (0018 fifth lane): replayHistory is exactly the left fold of replayEvent over the journal; the live step recordedHistory moves the history exactly as replaying the accepted event does, and liveHistoryReplays keeps the live history equal to the replay of the journal. Store durability and order, locking and PubSub delivery remain runtime boundaries.',
  'worker/replyReasons.vibe': 'Failure precedence and model reason codes; proved.',
  'worker/budgetDecision.vibe': 'Reservation admission: a call is admitted only when charges, open reservations and its own ceiling fit the limit, and holds that ceiling; settlement frees it and charges the usable report or the whole ceiling, once. Both preserve charges + reservations <= limit + over, where over counts only charges beyond their own reservation. Proved under the safe-sum precondition.',
  'src/core/flowDecision.vibe': 'Reply start/composition/settlement and Tour active/ready/one-speaker/terminal ordering models, exact closed invariants and at-most-one stage bounds; append order, tour terminal events, reading time, first undispatched source index, exact private visit/hold identities and scalar walk control choices; proved.',
};
const functionBoundaries = {
  "src/core/sandboxMock.vibe:memoryMachines": "Calls the proved command choice (sandboxMockDecision mockCommand: a redirected echo, cat, pwd, ls, echo, blank, else unavailable) and the current lease (currentLease: running at exactly that generation). The command regexps and the device's maps stay outside; they are tested.",
  "src/core/sandboxMock.vibe:makeMockSandboxes": "Wiring: the sandbox flows on the memory engine over the proved sandbox host (sandboxHost, sandboxDecision). The meter's alarm check belongs to the meter (vl-proof-strengthen); a flow error other than Refused or Unavailable is masked by a tag comparison the type checker narrows on.",
  "worker/ActionRuns.vibe:start": "Calls the proved start rule (actionRunDecision startRuns: a new or queued run, or a running post/tour needing recovery; terminal runs stay terminal), the settle rule and the settled state and result. The role gate is the catalog's proved allowed. Not proved: storage, the request comparison (JSON), the engine and the sequencer; they are tested.",
  "worker/ActionRuns.vibe:traced": "Calls the proved reply child id (replyChildId). Not proved: the trace queue, the consumer fiber and the sequencer writes; they are tested.",
  "worker/ActionRuns.vibe:alarm": "Calls the proved history outcome (historyPassed), tour settle rule (tourSettles) and settled state and result. Not proved: the engine, receipts, intent decoding and the sequencer; they are tested.",
  "worker/ActionRuns.vibe:cancel": "Calls the proved reply child test (isReplyChild) and cancellable states; the role gate is the catalog's proved allowed. Not proved: host cancellation, tour ending and the sequencer; they are tested.",
  "worker/ActionRuns.vibe:make": "Wiring: one host per object incarnation; admit applies the catalog's proved allowed to the stored request and fails a run whose permission changed.",
  "worker/ActionRuns.vibe:callerOf": "Wiring: the caller the door identified, read at its current role each time a step asks. Nothing to decide.",
  "worker/ActionRuns.vibe:read": "Wiring: decodes the sequencer's runs. Nothing to decide.",
  "src/core/MockAccounts.vibe:make": "Calls the proved self-grant rule (mockFactoryDecision selfGrant: only a signed-in person's own grant skips the roles gate), fixture logins, and the replay cursor and live tail the mock factory uses (afterCursor, replayedTo, liveEvent). Grants, authorization and roles are decide, apply and roleOf, proved in decide.vibe and conversation.vibe. Not proved: Refs, the lock, the engine and PubSub; they are tested.",
  "worker/Wiki.vibe:serveWiki": "Calls the proved request-key admission (issueHostDecision requestKey) and refusal status (wikiPageDecision wikiRefusalStatus). The URL path, method, content length and JSON body decoding stay runtime boundaries.",
  "worker/Wiki.vibe:wikiWriteKey": "Wiring: a SHA-256 of the write's identifying fields. Nothing to decide.",
  "worker/Wiki.vibe:publicWiki": "Wiring: serveWiki with no signed-in person, through the public reads client when given. Nothing to decide.",
  "src/core/wiki.vibe:wikiPath": "Calls the proved designs alias, page lookup and link (wikiPageDecision pageIdOf, pageIndex, wikiHref). The path normalization and section-name regexps stay boundaries (regexp.ts).",
  "src/core/wiki.vibe:wikiPage": "Calls the proved page lookup (pageIndex) on the path before any section; the split is native.",
  "src/core/wiki.vibe:wikiEditable": "Calls the proved editable rule (wikiPageDecision editable: a known page, never the generated decisions index).",
  "src/core/wiki.vibe:requestedWiki": "Calls the proved request precedence (wikiRequest), the longest named page id, earliest among ties (longestIncluded), and the first decision with the number (firstWithPrefix). The word and number regexps and case folding stay boundaries (regexp.ts, unicode-case.ts).",
  "worker/Wiki.vibe:wikiFilePath": "Calls the proved editable rule (wikiPageDecision editable); the path is the page under the repository root.",
  "worker/Wiki.vibe:wikiFailureOf": "Calls the proved GitHub failure reason and retry code (issueHostDecision failureReason, carriesCode), shared with the issues host. The delegation refusal branch is the Connect GitHub path (smithers.sh decision 0165) and is not proved.",
  "worker/Wiki.vibe:githubWikiHost": "Calls the proved editable rule and unwritten mark (wikiPageDecision wikiUnwritten: a first execution refused for conflict, empty or connect before writing). Not proved: GitHub reads and writes, draft storage, branch labels (regexp), review evidence and the order of writes; they are tested.",
  "worker/Wiki.vibe:executeWiki": "Calls the proved request-key admission (issueHostDecision requestKey) and the role gate (authorizeWiki, proved in conversation.vibe). Not proved: engine polling and recovery, run inspection and the stored-payload comparison; they are tested.",
  "src/core/WikiFactory.vibe:fixtureSource": "Calls the proved page lookup (wikiPageDecision pageIndex).",
  "src/core/WikiFactory.vibe:fixtureWikiHost": "Calls the proved fixture verdict (fixtureVerdict: read needs a known page; an edit needs a key, a known page and text; a save or proposal needs its base and a change), the editable rule and the review number. Not proved: draft and proposal bookkeeping in Refs and the lock; they are tested.",
  "src/core/WikiFactory.vibe:makeWikiFactory": "Wiring: the memory engine over the fixture host, the schema decode and the role gate (authorizeWiki, proved in conversation.vibe); an identity conflict reads as conflict, any other engine failure as failed.",
  "src/core/WikiFactory.vibe:makeWikiStore": "Wiring: empty Refs and a lock. Nothing to decide.",
  "src/core/WikiFactory.vibe:personOf": "Wiring: a fixture role names its fixture person, else the given identity is read. Nothing to decide.",
  "src/core/MockFactory.vibe:scripted": "Calls the proved reply choice (mockFactoryDecision replyKind: a requested specification review, then a wiki page, an issue to file or split, a sandbox, the history, else the script) and draft outcome; the script's first match is proved in mockDecision. Not proved: the prompt's regular expressions and case folding (regexp.ts, unicode-case.ts), the finds of the post's text and page label, answers that format numbers, and the durable actions; the flow and factory tests cover them.",
  "src/core/MockFactory.vibe:mockFactoryFor": "Calls the proved actor journal key (actorKey: neither a person and their device sign-in nor two ids share a journal), the restored id counter (never behind the journal), the replay cursor and live tail (afterCursor, replayedTo, liveEvent) and the tour-control step bound the Worker also uses (protocolDecision validTourStep). decide and apply are proved in decide.vibe and conversation.vibe. Not proved: locks, scopes, the engine, PubSub and streams; counter increments and lookups have nothing to decide. They are tested.",
  "src/core/MockFactory.vibe:cryptoOf": "Wiring: a supplied Digest, else the platform's Web Crypto. Nothing to decide.",
  "worker/Issues.vibe:issueFailureOf": "Calls the proved failure reason and retry code (issueHostDecision failureReason, carriesCode). The delegation refusal branch is the Connect GitHub path (smithers.sh decision 0165) and is not proved.",
  "worker/Issues.vibe:githubHost": "Calls the proved agent refusal, task and VIP reading, assignee choice label and login, timeline text and unwritten mark (issueHostDecision). Not proved: GitHub paging and decoding, the VIP marker regexp, the parent URL parse (Number), assignee order (localeCompare), the case-insensitive assignee check (toLowerCase), and the order of writes; they are tested.",
  "worker/Issues.vibe:serveIssues": "Calls the proved request-key admission and refusal status (issueHostDecision requestKey, refusalStatus). The URL path, content-length and JSON body decoding stay runtime boundaries.",
  "worker/Issues.vibe:executeIssues": "Calls the proved request-key admission, agent refusal, receipt-gated Accepted projection, advancing revision, resumable operations and resume status (issueHostDecision). Not proved: engine polling and recovery, run inspection, the stored-payload comparison and storage I/O; they are tested.",
  "src/web/actionModel.vibe:completions": "Calls the proved slashMatches (modelDecision): exactly the commands whose text starts with the draft's first word while the menu is open and that word starts with /; none otherwise. Reading the draft's first word is a native regexp outside the proof.",
  "src/core/sandboxMeter.vibe:meterDelayMilliseconds": "Calls the proved meter delay (sandboxDecision meterDelay): between 1 ms and one interval, and before the interval exactly the first whole millisecond at which running × elapsed reaches the remaining allowance.",
  "src/history/seed.vibe:areaOf": "Calls the proved first area naming the scope (seedDecision areaIndex); the scope regexps stay boundaries (regexp.ts).",
  "src/history/seed.vibe:wholeSentences": "Calls the proved note cut (seedDecision sentenceCut); the sentence-boundary regexps and trimming stay boundaries (regexp.ts).",
  "src/history/seed.vibe:evidenceOf": "Calls the proved evidence paragraph step (seedDecision evidenceStep); the trailer and own-line regexps stay boundaries (regexp.ts).",
  "src/history/seed.vibe:intentsOf": "Fold titles read back through the proved foldedTitle: an empty stored title is the mythical commit's own. Intent order is the loop order; that every intent is accepted is tested, not proved.",
  "src/history/seed.vibe:seedOf": "Calls the proved entry use and join precedence (seedDecision entryUse, joins). Not proved: the commit graph walk, the claim of the oldest landed entry, epic order and id numbering (Maps, regexps).",
  // Policy tables whose contract is the table (0018, "Specifications restated").
  ...Object.fromEntries(['src/core/conversation.vibe:mayRun', 'src/core/conversation.vibe:runsOf', 'src/core/wikiDecision.vibe:wikiSubmissionAllowed', 'src/core/protocolDecision.vibe:accountRoute',
    'worker/budgetDecision.vibe:canCharge', 'worker/budgetDecision.vibe:chargeKeyOf', 'src/core/accountCookieDecision.vibe:cookieName',
    'src/core/accountCookieDecision.vibe:localOrigin', 'src/core/accountCookieDecision.vibe:cookieAccepted', 'src/actions/catalogDecision.vibe:leastRoleOf',
    'src/actions/catalogDecision.vibe:inputOf', 'src/core/identityDecision.vibe:postLabel'].map((key) => [key, 'Specification restated: the contract is the table the body computes. It fixes the meaning other proofs rely on and rejects an edit to the table, but proves no further property, nor that callers pass the right argument.'])),
  "src/history/seed.vibe:pushOnce": "Calls the proved note-line admission (stackDecision admitsLine).",
  "src/actions/catalog.vibe:registration": "Calls the proved least role and input kind (catalogDecision); titles and command names are labels.",
  "src/core/accountCookies.vibe:validSessionCookie": "Calls the proved local-origin and cookie acceptance rule; the URL parse and cookie regexps stay boundaries (uri-codec.ts, regexp.ts).",
  "src/core/mockReplies.vibe:chunks": "Calls the proved exact chunk boundaries (mockDecision chunksOf): joined in order the chunks are the reply.",
  "worker/Reply.vibe:promptOf": "Calls the proved prompt window, form and speaker label; string joining is formatting.",
  "src/core/flows.vibe:touring": "Calls the proved runningTour.",
  "src/core/flows.vibe:docsPage": "Calls the proved exact docs-path admission (tourDecision docsPath), equal to the earlier regexp on 4,010 compared paths.",
  "src/history/pages.vibe:matchesOf": "Calls the proved pair-safe search clip, match count and search predicate (pageDecision found: a nonempty needle that is the id or occurs in the lowered title); case folding and the stack sort are native (unicode-case.ts, sort-membership.ts) and stay boundaries.",
  "src/history/pages.vibe:foldCounts": "Calls the proved per-key totals (pageDecision totals): each mythical commit maps to exactly the number of real commits folded into it, and one with none is absent.",
  "src/history/pages.vibe:headOf": "Calls the proved totalOf for the fold count (0 when nothing folds into the commit); the rest copies fields and counts notes.",
  "src/history/pages.vibe:stacked": "Sorts by the proved stack order (pageDecision stackOrder: negative, zero or positive exactly as epic position, then rank, order the two). The sort is the runtime's (sort-membership.ts). An unknown epic would sort first; apply never admits one (mythical.vibe).",
  "src/history/pages.vibe:outlineOf": "Calls the proved totals and totalOf: each epic's commit count and folded real commits are exactly the sums over its commits, 0 for an epic with none; the open list is the stacked commits the proved unlanded keeps.",
  "src/history/pages.vibe:commitPageOf": "Wiring: a native find by id and filter by fold target, nothing to decide beyond equality. Ids are unique because apply plans only under an unseen id (proved in mythical.vibe).",
  "src/history/pages.vibe:pageOf": "Wiring: dispatches each request kind to its reader (outlineOf, epicPageOf, commitPageOf, matchesOf), each proved or calling proved decisions.",
  "src/history/pages.vibe:epicPageOf": "Calls the proved page start and count; Math.floor and the rank sort are native (finite-round.ts, sort-membership.ts) and stay boundaries.",
  "src/history/seed.vibe:clip": "Calls the proved pair-safe cut (stackDecision pairCut), so a clipped title or note never ends in half a character; the native trimEnd is outside the proof.",
  "worker/Sequencer.vibe:entryOf": "Calls the proved first-match entryIndex; undefined exactly when no entry has the id.",
  "src/core/wikiDecision.vibe:wikiSubmissionAllowed": "Proved exact person-only submission guard; reads and drafts remain agent-invocable. Principal authentication and actual external writes are host boundaries.",
  "src/history/roles.vibe:atLeast": "Calls the shared proved role threshold; validated roles use the existing authoritative standing order.",
  "src/history/wire.vibe:statusOf": "Calls proved exact forbidden/unavailable/other refusal HTTP status mapping; no codec decision here.",
  "src/history/flows.vibe:signature": "Calls proved exact name/agent signature projection.",
  "src/web/historyApp.vibe:allowed": "Calls the shared proved role threshold; no duplicate role ranking.",
  "src/web/historyView.vibe:badgeOf": "Calls proved exact commit-state badge mapping; HtmlBuilder execution is outside this label policy.",
  "src/web/historyView.vibe:refusalText": "Calls proved exact product refusal labels and unknown-label preservation.",
  "src/history/mythical.vibe:replayEvent": "Retains every apply transition/frame over a validated safe event, including unchanged full snapshots; proved without weakening apply's below-capacity precondition.",
  "src/history/replayDecision.vibe:replayHistory": "Proved safe monotone cursor bounds, rank-below-cursor preservation, exact final cursor for contiguous validated events, and that the result is exactly the left fold replayedHistory, which the live step extends (0018 fifth lane). Store ordering remains a runtime boundary.",
  "src/history/mythical.vibe:decideWithinCapacity": "Exact capacity refusal and every decide postcondition, including append/insertion rank, lifted through the production wrapper; proved.",
  "src/history/seed.vibe:replay": "Calls proved capacity decision and apply; safe-limit overflow fixed by failing-first regressions. Complete intent-fold/refusal-order contracts and arbitrary malformed starting snapshots remain unproved.",
  "src/core/conversation.vibe:applyIssues": "Exact next-numbered observation replacement and stale/future no-op; requires a safe sequence below capacity. The host cursor domain remains to audit (0022).",
  "src/core/conversation.vibe:issuePermission": "Exact least-role permission for each issue operation, through the shared role policy (0022).",
  "src/core/conversation.vibe:issuePolicyAction": "Exact mapping of each issue operation to the shared authorization action (0022).",
  "src/core/issueGraphDecision.vibe:issueAncestorAt": "Specification measure only: zero steps retain the start; each positive step uses the first matching record parent, root zero is absorbing and missing records return -1. Each step clause is proved independently and mutated.",
  "src/core/IssuesFactory.vibe:noteOf": "The event line each edit adds to its issue: product text, no decision. The edit itself goes through the proved issuesAfter.",
  "src/core/issueGraphDecision.vibe:canLinkIssues": "Accepted links have positive distinct existing child identities and a bounded first-match parent path reaching the root without the child; issuesAfter proves from this guarantee that the link keeps the issues a forest (0022, 0018 fifth lane).",
  "src/core/conversation.vibe:setCommitment": "Exact commit/uncommit assignment and task state; all issue identity, tree, content and review fields preserved. Commit requires nonempty assignee (0022).",
  "src/core/conversation.vibe:approveVip": "Only a maintainer person with nonempty identity and time can accept an in-review VIP; task and issue identity are preserved (0027).",
  "src/core/conversation.vibe:declineVip": "An in-review VIP becomes Declined and closed, preserving its task; other states are unchanged (0027).",
  "src/core/conversation.vibe:specificationReviewPasses": "Exact same-revision LGTM/A- or better with a nonempty review receipt (0027).",
  "src/core/conversation.vibe:specificationAccepted": "Exactly the conjunction of Astra, Sol, Fable and Opus on one current revision (0027).",
  "src/core/conversation.vibe:unansweredSpecificationReview": "Exact empty answer, grade, revision and link (0027).",
  "src/core/conversation.vibe:reviseSpecification": "Changed content increments the immutable revision and resets every field of all four answers; equal content is unchanged (0027).",
  "src/core/conversation.vibe:recordSpecificationReview": "Only the bound reviewer records their current-revision verdict and receipt; unrelated seats, revision and text are preserved (0027).",
  "src/core/conversation.vibe:reviewActions": "Exact admissibility and remaining label/close actions after a partial review; GitHub action execution is outside this decision (0022)."
};
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const logicNodes = new Set(['IfStatement', 'SwitchStatement', 'WhileStatement', 'DoWhileStatement',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'ConditionalExpression', 'LogicalExpression',
  'BinaryExpression', 'UnaryExpression', 'UpdateExpression', 'AssignmentExpression', 'MatchExpression']);
function children(node) {
  return Object.entries(node).filter(([key]) => !['tokens', 'comments', 'loc', 'range'].includes(key))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter(value => value && typeof value === 'object' && typeof value.type === 'string');
}
function containsLogic(node) {
  if (functions.has(node.type)) return false; // Nested functions have their own inventory row.
  return logicNodes.has(node.type) || (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
    && (['filter', 'find', 'findIndex', 'some', 'every', 'includes', 'has', 'indexOf', 'lastIndexOf', 'sort', 'reduce', 'test', 'exec', 'slice', 'join', 'map', 'stringify', 'startsWith', 'endsWith', 'trim', 'toLowerCase', 'toUpperCase', 'max', 'min', 'round', 'floor', 'ceil', 'abs', 'parseInt', 'parseFloat'].includes(node.callee.property?.name) || /^is[A-Z]/.test(node.callee.property?.name ?? '')))
    || children(node).some(containsLogic);
}
const effectRoots = new Set(['Effect', 'Ref', 'Queue', 'PubSub', 'Semaphore', 'Clock', 'Console', 'Logger', 'Runtime', 'Dom', 'document', 'window']);
const domEffects = new Set(['focus', 'blur', 'scrollTo', 'scrollIntoView', 'setAttribute', 'appendChild', 'removeChild', 'addEventListener', 'removeEventListener', 'getBoundingClientRect', 'querySelector', 'querySelectorAll']);
function containsEffects(node) {
  if (functions.has(node.type)) return false;
  if (node.type === 'CallExpression') {
    let root = node.callee;
    while (root?.type === 'MemberExpression') root = root.object;
    if (effectRoots.has(root?.name) || ['fetch', 'setTimeout', 'queueMicrotask'].includes(root?.name)
      || (node.callee?.type === 'MemberExpression' && domEffects.has(node.callee.property?.name))) return true;
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression'
    && ['scrollTop', 'scrollLeft', 'innerHTML', 'textContent'].includes(node.left.property?.name)) return true;
  return children(node).some(containsEffects);
}
function inventorySource(file, source) {
  const rel = path.relative(app, file);
  const parsed = spawnSync(path.join(app, 'node_modules/.bin/vibelang'), ['--estree', file],
    { input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (parsed.error || parsed.status !== 0) throw Error(`${rel}: compiler AST failed: ${parsed.error?.message ?? parsed.stderr}`);
  const result = JSON.parse(parsed.stdout);
  if (result.error || !result.ast) throw Error(`${rel}: compiler parse failed: ${result.error?.message ?? 'missing AST'}`);
  const rows = [];
  // A function whose leading `//@` block holds LemmaScript's verify directive (the harness's own pattern, sources.py)
  // is proved by `pnpm verify`, with the callbacks inside it.
  const directive = /^[ \t]*\/\/@[ \t]+verify\b/;
  function markedAt(start) {
    const before = source.slice(0, start).split('\n');
    for (let i = before.length - 2; i >= 0 && /^[ \t]*\/\/@/.test(before[i]); i--) if (directive.test(before[i])) return true;
    return false;
  }
  function walk(node, parent, parents = [], provedBy = false) {
    let next = parents;
    let proved = provedBy;
    if (functions.has(node.type) && node.body) {
      // ESTree ranges index the ORIGINAL JavaScript string (UTF-16). Projection
      // mappings instead use UTF-8 bytes and include generated $gen wrappers.
      const method = parent?.type === 'MethodDefinition' || (parent?.type === 'Property'
        && (parent.method || parent.kind === 'get' || parent.kind === 'set'));
      const declaration = method ? parent : node;
      const range = declaration.range;
      if (!range || range[0] < 0 || range[1] > source.length || range[0] >= range[1]) {
        throw Error(`${rel}: executable function has no valid original-source range`);
      }
      const line = source.slice(0, range[0]).split('\n').length;
      const name = node.id?.name ?? (parent?.type === 'VariableDeclarator' ? parent.id?.name : undefined)
        ?? (['Property', 'MethodDefinition'].includes(parent?.type) ? parent.key?.name ?? parent.key?.value : undefined)
        ?? `callback@${line}`;
      // Look only at the original declaration header: strings/comments and nested
      // effect functions do not turn a plain enclosing function into an Effect.
      const header = source.slice(range[0], node.body.range[0]);
      const effectful = /^(?:(?:export|default|static|public|private|protected|override)\s+)*effect\b/.test(header.trim()) || node.async || containsEffects(node.body);
      const category = effectful ? 'effectful shell' : (containsLogic(node.body) || boundaries[rel] ? 'pure logic' : 'wiring');
      proved = provedBy || (parents.length === 0 && markedAt(range[0]));
      const boundary = boundaries[rel];
      const provedBoundary = proved && boundary && !boundary.startsWith('Proved') ? 'Proved: ' + boundary : boundary;
      const why = functionBoundaries[`${rel}:${parents[0] ?? name}`] || provedBoundary || shellBoundaries[rel]
        || (proved ? 'Proved: marked `//@ verify`; Dafny checks its contract and every precondition it calls (`pnpm verify`).' : undefined) || (category === 'wiring'
        ? 'Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision.'
        : 'Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof.');
      const label = [...parents, name].join('/');
      rows.push({ file: rel, line, label, category, why });
      next = [...parents, name];
    }
    for (const child of children(node)) walk(child, node, next, proved);
  }
  walk(result.ast);
  return rows;
}
/** The production sources the inventory enumerates, never generated output. */
function sourceFiles() {
  // Build output is not source: `pnpm wiki:build` writes the gitignored src/assets/wiki.generated.vibe (data only).
  return ['src', 'worker', 'scripts'].flatMap(d => scan(path.join(app, d))).filter(file => !file.endsWith('.generated.vibe'));
}
function main() {
  const rows = sourceFiles().flatMap(file => inventorySource(file, fs.readFileSync(file, 'utf8')));
  const table = `<!-- inventory:start -->\n${rows.length} executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.\n\n| File and line | Function | Class | Proof or reason |\n| --- | --- | --- | --- |\n${rows.map(row => `| \`${row.file}:${row.line}\` | \`${row.label}\` | ${row.category} | ${row.why} |`).join('\n')}\n<!-- inventory:end -->`;
  const before = fs.readFileSync(decision, 'utf8');
  if (!/<!-- inventory:start -->[\s\S]*?<!-- inventory:end -->/.test(before)) throw Error('Missing inventory markers');
  const after = before.replace(/<!-- inventory:start -->[\s\S]*?<!-- inventory:end -->/, () => table);
  if (process.argv.includes('--write')) fs.writeFileSync(decision, after);
  else if (before !== after) { console.error('Function inventory is stale: node verify/inventory.cjs --write'); process.exitCode = 1; }
  console.log(`${rows.length} executable functions, callbacks and effect blocks inventoried`);
}
module.exports = { inventorySource, sourceFiles };
if (require.main === module) main();
