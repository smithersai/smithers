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
  'src/web/main.vibe': 'Calls proved screenDecision policies and the conversation machine; full Foldkit update objects, pending-post selection and command execution remain unproved.',
  'src/web/viewport.vibe': 'Follow revisions and pause decisions are proved in screenDecision under integer coordinates; DOM observations/writes, floating-point pixels and touch lookup remain runtime boundaries.',
  'src/core/mockReplies.vibe': 'First matching script is proved in mockDecision; Unicode casing and slicing chunks remain unproved (unicode-case.ts, slice-clamp reproduction).',
  'src/core/wire.vibe': 'Length and method/subroute admission are proved in protocolDecision; URI codecs remain unproved (uri-codec.ts).',
  'src/core/LiveFactory.vibe': 'HTTP outcome choice is proved in protocolDecision; HTTP/SSE and Schema codecs remain runtime boundaries (json-codec.ts).',
  'src/surfaces/commands.vibe': 'Conversation/cursor admission calls proved protocolDecision predicates, retaining schema annotations. Command event accumulation and formatting remain unproved.',
  'src/surfaces/backend.vibe': 'Host choice calls proved prefersMock/liveHealth policies; URL normalization and layer execution remain unproved.',
  'src/web/backend.vibe': 'Health choice calls proved liveHealth; deadlines, cancellation and layer loading remain runtime behavior.',
  'worker/Http.vibe': 'Body-length admission uses protocolDecision; URI/JSON/Schema decoding, SSE framing and HTTP execution remain runtime boundaries.',
  'worker/Budget.vibe': 'Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts).',
  'worker/Reply.vibe': 'Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved.',
  'src/core/flows.vibe': 'Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. The reading-time policy is proved too; flow execution, word tokenization, docs regexp and reply-id slice remain unproved.',
  'worker/Sequencer.vibe': 'Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved.',
  'src/history/flows.vibe': 'Who may act and the order of authorize and record steps run the proved flowMachine.vibe (authorize, canRecord, record); the sequencer decides through mythical.vibe. Engine execution, journaling, metrics and logs remain runtime boundaries (0020).',
  'src/history/Sequencer.vibe': 'Calls the proved decide, apply and foldTarget. Locking, store-before-publish, epic opening for untrailered folds, title truncation and the trailer regexp remain unproved (0020).',
  'src/history/roles.vibe': 'may, leastRole, peopleOnly and standing are proved in flowMachine.vibe; this module re-exports them and builds the role tables from them (0020).',
};
const boundaries = {
  'src/core/mockDecision.vibe': 'Exact keyword membership, first-match priority and fallback; proved for normalized prompts.',
  'src/core/protocolDecision.vibe': 'Conversation/cursor/body validation, exact route and HTTP outcomes, explicit backend choice; proved.',
  'src/web/screenDecision.vibe': 'Escape/palette/minimize/scroll/focus intent/tour-stream/announcement/shortcut decisions; proved in Dafny integer model, not fractional DOM or IEEE-754.',
  'src/history/mythical.vibe': 'Mythical-history machine: numbering, linearity, no lost epic, commit, real commit or note, exactly-one folds, and a trailer folds only into an approved or landed commit; proved, with executable mutations (0020).',
  'src/history/flowMachine.vibe': 'Who may take each history action, and each flow run: authorized once, records only after an allowed authorization, the agent never records an approval or fold; proved, with executable mutations (0020).',
  'src/core/conversation.vibe': 'Production state machine; contracts and executable mutations.',
  'worker/replyReasons.vibe': 'Failure precedence and model reason codes; proved.',
  'worker/budgetDecision.vibe': 'Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition.',
  'src/core/flowDecision.vibe': 'Dispatch admission, append ordering, tour terminal events and reading-time policy; proved.',
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
    && ['filter', 'find', 'sort', 'reduce', 'test', 'exec', 'slice', 'join', 'map', 'stringify'].includes(node.callee.property?.name))
    || children(node).some(containsLogic);
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
      const effectful = /^(?:(?:export|default|static|public|private|protected|override)\s+)*effect\b/.test(header.trim()) || node.async;
      const category = effectful ? 'effectful shell' : (containsLogic(node.body) || boundaries[rel] ? 'pure logic' : 'wiring');
      const why = boundaries[rel] || shellBoundaries[rel] || (category === 'wiring'
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
