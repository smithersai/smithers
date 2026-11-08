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
  'worker/Budget.vibe': 'Calls proved admission/charge decisions; semaphore, ledger I/O and finite-round normalization are runtime boundaries (finite-round.ts).',
  'worker/Reply.vibe': 'Reason classification is proved in replyReasons.vibe; agent/event decoding, streaming, interruption and step execution remain unproved.',
  'src/core/flows.vibe': 'Dispatch and terminal-event decisions are proved in flowDecision.vibe; conversation guards in conversation.vibe. Flow execution, docs regexp and reply-id slice remain unproved.',
  'worker/Sequencer.vibe': 'Calls the proved conversation and append/start decisions. Locking, log order, replay reads, history selection and restart iteration remain unproved.',
};
const boundaries = {
  'src/history/mythical.vibe': 'Inherited mythical-history machine contracts; checked by the shared proof gate (0020). Mutation coverage is being extended in this lane.',
  'src/core/conversation.vibe': 'Production state machine; contracts and executable mutations.',
  'worker/replyReasons.vibe': 'Failure precedence and model reason codes; proved.',
  'worker/budgetDecision.vibe': 'Strict admission, nonnegative integer charge and exact total; proved under safe-sum precondition.',
  'src/core/flowDecision.vibe': 'Dispatch admission, append ordering and tour terminal events; proved.',
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
