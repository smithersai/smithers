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
  'src/web/historyApp.vibe': 'Calls proved role thresholds, live role reset, open-epic membership, plan initialization/validation/field selection. Remaining page merges, async response guards, complete model frames and command scheduling remain unproved.',
  'src/history/LiveMythical.vibe': 'Calls proved accepted/refused/unavailable HTTP outcome mapping. Native HTTP/SSE and JSON/Schema codecs remain boundaries.',

  'worker/Reply.vibe': 'Threads the proved Reply start/compose/settle model through actual Actions and calls the proved complete event router/completion choices; invalid telemetry retains prior valid spend and cannot publish success. Native SDK payload projection and effect orchestration remain unproved; native safe-integer observations, AgentAction internal event replay, DoneText/provider decoding and date/prompt formatting remain host boundaries.',
  'worker/Objects.vibe': 'The live dispatcher uses the proved scan/attempt/done transition; only a successful engine start writes a mark. Intent/storage codecs, engine execution, alarms and runtime composition remain host boundaries.',
  'src/web/theatre.vibe': 'Calls the proved selector, speech action, audio identity, outcome and focus-index policies. DOM geometry and native number subtraction, speech APIs, persisted JSON decoding and host execution remain boundaries.',
  'src/history/Sequencer.vibe': 'Calls the proved history machine, rank validation and capacity guard. Decodes storage/replay/follow/bootstrap with redacted errors. Fold targets call the proved foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and trailer regexp remain unproved.',
  'src/history/schemas.vibe': 'Rank bounds call proved validRank/validRanks; Schema safe-integer and JSON decoding remain runtime boundaries (unsafe-integer.ts, json-codec.ts).',
  'worker/HistoryObject.vibe': 'Uses the redacted validated history decoder before replay; chunking, JSON serialization and durable flow execution remain unproved.',
  'src/web/main.vibe': 'Calls proved six-field surface/tour projections, pane/media/response guards, scroll/focus policies and conversation transitions. Full Model composition, account/People transitions, numeric counter domains, retry selection and command execution remain unproved.',
  'src/web/viewport.vibe': 'Follow revisions and finite-coordinate comparison decisions are proved in screenDecision; DOM observations/writes, native subtraction, nonfinite inputs, counter capacity and touch lookup remain runtime boundaries.',
  'src/core/mockReplies.vibe': 'First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction).',
  'src/core/wire.vibe': 'Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts).',
  'src/core/LiveFactory.vibe': 'HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts).',
  'src/surfaces/commands.vibe': 'Conversation/cursor admission calls proved protocolDecision; commandDecision proves reply accumulation and outcome/error mapping. Schema decoding, stream execution and formatting remain boundaries.',
  'src/surfaces/backend.vibe': 'Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved.',
  'src/web/startup.vibe': 'Calls proved startupDecision choices for preference, authoritative role list and saved tutorial controls. URL parsing, storage effects, storage-denial fallback, resource loading and Foldkit startup remain host boundaries.',
  'src/web/historyStartup.vibe': 'Calls proved startupDecision preference and authoritative role-list/default choices. Storage, URL parsing, resource loading and Foldkit execution remain host boundaries.',
  'src/web/modeSwitch.vibe': 'Calls the proved opposite-mode choice; HtmlBuilder rendering and native navigation remain host boundaries.',
  'src/web/backend.vibe': 'Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior.',
  'worker/Http.vibe': 'Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries.',
  'worker/Budget.vibe': 'Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts).',
  'worker/Reply.vibe': 'Reason classification and the latest-turn window call proved replyReasons/sequenceDecision. Agent/event decoding, token progress, streaming, interruption and step execution remain unproved.',
  'src/core/flows.vibe': 'Post/StartTour/EndTour thread the proved record/follow-up model, and Tour threads active/ready/one-speaker/terminal state; terminal-event and reading-time policies call flowDecision; unanswered source order and conversation guards call conversation. Flow execution, word tokenization, docs regexp and reply-id slice remain unproved.',
  'worker/Sequencer.vibe': 'Calls proved conversation/append/start decisions, retained-log replay and ordered model-context selection. Stored events are decoded before replay. Locking, writer/log composition, follow ordering and restart iteration remain unproved.',
  'src/history/flows.vibe': 'Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020).',
  'src/history/roles.vibe': 'may, leastRole, peopleOnly and standing are proved in flowMachine.vibe; this module re-exports them and builds the role tables from them (0020).',
};
const boundaries = {
  'worker/replyProgressDecision.vibe': 'Complete event-kind routing, ignored/non-text identity transitions, closed bounded token invariant, zero base/exact sum recurrence, native-validation admission flags, text/retry/failure frames, latched malformed telemetry and completion precedence; proved over the established integer domain. Native Number.isSafeInteger observations and provider/DoneText decoding are host boundaries (safe-usage-integer.ts).',
  'worker/liveDispatchDecision.vibe': 'Proved exact scan cursor and first-unmarked selection, no skipped unmarked post, terminal idempotency and one engine attempt per invocation, including refusal; storage-mark truth and engine execution are host boundaries.',
  'src/web/theatreDecision.vibe': 'Proved exact target selectors, speech cancellation/pause/resume/replacement priority, no duplicate speech on redraw, audio identity invalidation, bounded outcome labels and keyboard focus wrapping; native speech, DOM and persistence remain host boundaries.',
  'src/web/startupDecision.vibe': 'Proved explicit query precedence, preference writes, authoritative role-list membership/default, saved tutorial controls and the opposite-mode switch; native URL/storage effects and storage-failure fallback remain host boundaries.',
  'src/web/viewDecision.vibe': 'Proved refusal/status labels, entry display flags, send/transition choices, sandbox pane/response/action guards and media failure/motion choices. Rendering, asset lookup and actual DOM execution remain host boundaries.',
  'src/surfaces/commandDecision.vibe': 'Proved own-post/reply correlation, exact ordered event-number accumulation, text/restart/terminal state, outcome and error mapping; UUID generation, streams and rendering are Effect/host boundaries.',
  'src/core/sequenceDecision.vibe': 'Proved first matching post prefix, exact eligible source indexes in strict order, role/text projection, exclusion of failed/unfinished/tour answers and latest-turn window; model execution remains an Effect boundary.',
  'src/core/sandboxDecision.vibe': 'Sandbox integer kernel, iterative runtime traversals and quantified source-position contracts: exact running counts, interval usage and accumulation, remaining allowance, monotone clocks, refusal precedence, first-match lookup, identity fences and transition frames (0024). Date/IEEE-754 normalization and durable shell behavior remain outside these clauses.',
  'src/core/mockDecision.vibe': 'Exact keyword membership, first-match priority and fallback; proved for normalized prompts.',
  'src/core/protocolDecision.vibe': 'Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved.',
  'src/web/screenDecision.vibe': 'Exact six-field surface/tour projections plus escape, palette, scroll, focus, stream and announcement decisions; finite coordinate comparisons use exact reals. Native subtraction, nonfinite inputs and counter-capacity applicability remain unproved.',
  'src/history/mythical.vibe': 'Exact history transitions and unchanged fields, refusal precedence, first-match lookup, rank-bound induction and sequence capacity; notes are retained and trailers fold only into approved or landed commits; proved over validated safe integers (0020, unsafe-integer.ts).',
  'src/history/flowMachine.vibe': 'History authorization/run ordering plus shared role thresholds, HTTP outcomes, plan validation/fields, open-epic membership, role reset and product labels; exact scalar and set/prefix contracts with executable mutations (0020). Native codecs, complete page/model transitions and engine replay remain boundaries.',
  'src/core/conversation.vibe': 'Production state machine: exact entry/role frames, pending source positions, unanswered order, replay cursor bounds, guards and policy contracts with executable mutations; stated integer/UTF-16 domain.',
  'worker/replyReasons.vibe': 'Failure precedence and model reason codes; proved.',
  'worker/budgetDecision.vibe': 'Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition.',
  'src/core/flowDecision.vibe': 'Post/StartTour/EndTour record-before-follow-up-once, Reply start/composition/settlement and Tour active/ready/one-speaker/terminal ordering models, exact closed invariants and at-most-one stage bounds; dispatch admission, append order, tour terminal events, reading time and first undispatched source index; proved.',
};
const functionBoundaries = {
  "src/history/roles.vibe:atLeast": "Calls the shared proved role threshold; validated roles use the existing authoritative standing order.",
  "src/history/wire.vibe:statusOf": "Calls proved exact forbidden/unavailable/other refusal HTTP status mapping; no codec decision here.",
  "src/history/flows.vibe:signature": "Calls proved exact name/agent signature projection.",
  "src/web/historyApp.vibe:allowed": "Calls the shared proved role threshold; no duplicate role ranking.",
  "src/web/historyView.vibe:badgeOf": "Calls proved exact commit-state badge mapping; HtmlBuilder execution is outside this label policy.",
  "src/web/historyView.vibe:refusalText": "Calls proved exact product refusal labels and unknown-label preservation.",
  "src/history/mythical.vibe:replayEvent": "Retains every apply transition/frame over a validated safe event, including unchanged full snapshots; proved without weakening apply's below-capacity precondition.",
  "src/history/mythical.vibe:replayHistory": "Proved safe monotone cursor bounds, rank-below-cursor preservation and exact final cursor for contiguous validated events. Full replay-state equivalence and journal ordering remain unproved.",
  "src/history/mythical.vibe:decideWithinCapacity": "Exact capacity refusal and every decide postcondition, including append/insertion rank, lifted through the production wrapper; proved.",
  "src/history/seed.vibe:replay": "Calls proved capacity decision and apply; safe-limit overflow fixed by failing-first regressions. Complete intent-fold/refusal-order contracts and arbitrary malformed starting snapshots remain unproved.",
  "src/core/conversation.vibe:applyIssues": "Exact next-numbered observation replacement and stale/future no-op; requires a safe sequence below capacity. The host cursor domain remains to audit (0022).",
  "src/core/conversation.vibe:issuePermission": "Exact least-role permission for each issue operation, through the shared role policy (0022).",
  "src/core/conversation.vibe:issuePolicyAction": "Exact mapping of each issue operation to the shared authorization action (0022).",
  "src/core/conversation.vibe:issueAncestorAt": "Specification measure only: zero steps retain the start; each positive step uses the first matching record parent, root zero is absorbing and missing records return -1. Each step clause is proved independently and mutated.",
  "src/core/conversation.vibe:canLinkIssues": "Accepted links have positive distinct existing child identities and a bounded first-match parent path reaching the root without the child. This proves no cycle is introduced along that path; the complete global graph invariant and acceptance completeness remain unproved (0022).",
  "src/core/conversation.vibe:setCommitment": "Exact commit/uncommit assignment and task state; all issue identity, tree, content and review fields preserved. Commit requires nonempty assignee (0022).",
  "src/core/conversation.vibe:approveVip": "Only a maintainer person with nonempty identity and time can accept an in-review VIP; task and issue identity are preserved (0027).",
  "src/core/conversation.vibe:declineVip": "An in-review VIP becomes Declined and closed, preserving its task; other states are unchanged (0027).",
  "src/core/conversation.vibe:specificationReviewPasses": "Exact current-revision LGTM/A with a nonempty review receipt (0027).",
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
  function walk(node, parent, parents = []) {
    let next = parents;
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
      const why = functionBoundaries[`${rel}:${parents[0] ?? name}`] || boundaries[rel] || shellBoundaries[rel] || (category === 'wiring'
        ? 'Forwards values, constructs a schema/view/layer, or calls the owning API; no admission or state decision.'
        : 'Not yet proved: production logic must be extracted or its tool boundary reproduced; behavioral tests are not a proof.');
      const label = [...parents, name].join('/');
      rows.push({ file: rel, line, label, category, why });
      next = [...parents, name];
    }
    for (const child of children(node)) walk(child, node, next);
  }
  walk(result.ast);
  return rows;
}
function main() {
  const rows = ['src', 'worker', 'scripts'].flatMap(d => scan(path.join(app, d)))
    .flatMap(file => inventorySource(file, fs.readFileSync(file, 'utf8')));
  const table = `<!-- inventory:start -->\n${rows.length} executable functions, callbacks and effect blocks, enumerated from the compiler's original-source AST.\n\n| File and line | Function | Class | Proof or reason |\n| --- | --- | --- | --- |\n${rows.map(row => `| \`${row.file}:${row.line}\` | \`${row.label}\` | ${row.category} | ${row.why} |`).join('\n')}\n<!-- inventory:end -->`;
  const before = fs.readFileSync(decision, 'utf8');
  if (!/<!-- inventory:start -->[\s\S]*?<!-- inventory:end -->/.test(before)) throw Error('Missing inventory markers');
  const after = before.replace(/<!-- inventory:start -->[\s\S]*?<!-- inventory:end -->/, () => table);
  if (process.argv.includes('--write')) fs.writeFileSync(decision, after);
  else if (before !== after) { console.error('Function inventory is stale: node verify/inventory.cjs --write'); process.exitCode = 1; }
  console.log(`${rows.length} executable functions, callbacks and effect blocks inventoried`);
}
module.exports = { inventorySource };
if (require.main === module) main();
