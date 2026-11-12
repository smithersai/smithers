const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { inventorySource, sourceFiles } = require('./inventory.cjs');
const app = path.resolve(__dirname, '..');

test('non-ASCII prefixes retain exact original function and callback lines', () => {
  const source = '// 😀 — café\nexport function pick(xs: string[]) {\n  return xs.filter(x => x !== "effect try yield")\n}\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(({ label, line, category }) => ({ label, line, category })), [
    { label: 'pick', line: 2, category: 'pure logic' },
    { label: 'pick/callback@3', line: 3, category: 'pure logic' },
  ]);
});

test('real flows and extracted selection retain original declarations without generated wrappers', () => {
  const file = path.join(app, 'src/core/flows.vibe');
  const source = fs.readFileSync(file, 'utf8');
  const rows = inventorySource(file, source);
  const expectedLine = source.slice(0, source.indexOf('export function endsTour')).split('\n').length;
  assert.equal(rows.find(row => row.label === 'endsTour')?.line, expectedLine);
  assert.equal(rows.find(row => row.label === 'unanswered')?.category, 'wiring');
  const decision = path.join(app, 'src/core/conversation.vibe');
  assert.equal(inventorySource(decision, fs.readFileSync(decision, 'utf8')).find(row => row.label === 'unansweredIndexes')?.category, 'proved');
  assert.equal(rows.filter(row => row.label.startsWith('unanswered/')).length, 0);
  assert.equal(rows.some(row => /\$gen|callback@85\/callback@85/.test(row.label)), false);
});

test('original effect declarations, blocks, constructors, methods and getters are inventoried', () => {
  const source = 'export effect function work() { return 1 }\n' +
    'const action = effect (x: number) => x + 1\n' +
    'const task = effect { return 1 }\n' +
    'class C { constructor() {} get value() { return 1 } effect run() { return 2 } }\n' +
    'const object = { read: effect () => 1, effect write() { return 2 } }\n' +
    'const example = "function fake() {}"\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(row => row.label), ['work', 'action', 'callback@3', 'constructor', 'value', 'run', 'read', 'write']);
  assert.deepEqual(rows.filter(row => row.category === 'effectful shell').map(row => row.label), ['work', 'action', 'callback@3', 'run', 'read', 'write']);
});

test('a source whose compiler AST is larger than 16 MiB is still inventoried', () => {
  // The generated wiki module (src/assets/wiki.generated.vibe) crossed 16 MiB of AST JSON on 2026-11-10.
  const source = `export const big = "${'a'.repeat(9 * 1024 * 1024)}"\nexport function positive(x: number) { return x > 0 }\n`;
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(({ label, line }) => ({ label, line })), [{ label: 'positive', line: 2 }]);
});

test('a function directly under a //@ verify contract, and its callbacks, are proved; others are not', () => {
  const source = '/** Doc. */\n//@ verify\n//@ ensures \\result == (x > 0)\nexport function positive(x: number): boolean {\n' +
    '  return [x].some(v => v > 0)\n}\n' +
    'export function negative(x: number): boolean { return x < 0 }\n' +
    '//@ verify\nexport function first(x: number): number { return x }\n' +
    'const gap = 1\n' +
    'export function after(x: number): boolean { return x > gap }\n' +
    '/** Mentions //@ verify in prose. */\nexport function prose(x: number): boolean { return x > 1 }\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(({ label, category }) => ({ label, category })), [
    { label: 'positive', category: 'proved' },
    { label: 'positive/callback@5', category: 'proved' },
    { label: 'negative', category: 'pure logic' },
    { label: 'first', category: 'proved' },
    { label: 'after', category: 'pure logic' },
    { label: 'prose', category: 'pure logic' },
  ]);
});

test('marked checks are not labelled absent, and a restated policy says so', () => {
  // The review found the proved decide module listed as "Not yet proved" (0018, finding 7); a marked function is checked; its output guarantee still needs a postcondition.
  const unproved = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    if (!/^[ \t]*\/\/@[ \t]+verify\b/m.test(source)) continue;
    const lines = source.split('\n');
    for (const row of inventorySource(file, source)) {
      let i = row.line - 2, marked = false;
      while (i >= 0 && /^\s*(\/\/|\/\*\*|\*)/.test(lines[i])) { if (/^\s*\/\/@\s+verify\b/.test(lines[i])) marked = true; i--; }
      if (marked && row.why.startsWith('Not yet proved')) unproved.push(`${row.file}:${row.line} ${row.label}`);
    }
  }
  assert.deepEqual(unproved, []);
  const conversation = path.join(app, 'src/core/conversation.vibe');
  const mayRun = inventorySource(conversation, fs.readFileSync(conversation, 'utf8')).find(row => row.label === 'mayRun');
  assert.match(mayRun.why, /^Specification restated/);
});

test('malformed source cannot produce a successful partial inventory', () => {
  assert.throws(() => inventorySource(path.join(app, 'inventory-fixture.vibe'), 'export function broken('), /parse|compiler|syntax/i);
});

test('membership and numeric predicates are decisions, while native DOM work is an effect shell', () => {
  const source = 'function member(values: string[], value: string) { return values.includes(value) }\n' +
    'function safe(value: number) { return Number.isSafeInteger(value) }\n' +
    'function focus(element: HTMLElement) { element.focus() }\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(({ label, category }) => ({ label, category })), [
    { label: 'member', category: 'pure logic' },
    { label: 'safe', category: 'pure logic' },
    { label: 'focus', category: 'effectful shell' },
  ]);
});

test('build output is not source: a generated module never enters the inventory', () => {
  // `pnpm wiki:build` (run by typecheck and test) writes the gitignored src/assets/wiki.generated.vibe, megabytes of
  // data whose AST once overflowed the compiler pipe, so the inventory failed after any build.
  const generated = path.join(app, 'src/assets/wiki.generated.vibe');
  const files = sourceFiles();
  if (fs.existsSync(generated)) assert.equal(files.includes(generated), false);
  assert.equal(files.some(file => file.endsWith('.generated.vibe')), false);
  assert.ok(files.includes(path.join(app, 'src/core/flows.vibe')));
});

test('a marked contract reads as proved, while a marker alone states its missing postcondition', () => {
  // decide.vibe and six other marked modules read "Not yet proved" while `pnpm verify` proved them (vl-audit-vl29).
  const source = '// Fixture.\n//@ verify\n//@ ensures \\result == (a > b)\nexport function more(a: number, b: number) {\n  return [a].some(x => x > b)\n}\n' +
    'export function less(a: number, b: number) { return a < b }\n  //@  verify\nfunction spaced(a: number) { return a > 0 }\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  const why = Object.fromEntries(rows.map(row => [row.label, row.why]));
  assert.match(why.more, /^Proved/);
  assert.match(why['more/callback@5'], /^Proved/);
  assert.match(why.less, /^Not yet proved/);
  assert.match(why.spaced, /without a behavioral postcondition/);
  const decide = path.join(app, 'src/core/decide.vibe');
  const row = inventorySource(decide, fs.readFileSync(decide, 'utf8')).find(entry => entry.label === 'decide');
  assert.match(row.why, /^Proved/);
  const conversation = path.join(app, 'src/core/conversation.vibe');
  const query = inventorySource(conversation, fs.readFileSync(conversation, 'utf8')).find(entry => entry.label === 'tourWalkthrough');
  assert.match(query.why, /without a behavioral postcondition/);
});

test('native SQL, storage and clock calls are effect shells while regexp exec and Map membership stay logic', () => {
  const source = 'function query() { return state.raw.storage.sql.exec("SELECT 1").toArray() }\n' +
    'function read() { return state.raw.storage.get("key") }\n' +
    'function write() { return state.raw.storage.put("key", 1) }\n' +
    'function now() { return Date.now() }\n' +
    'function pattern(text: string) { return /^a/.exec(text) }\n' +
    'function member(storage: Map<string, string>) { return storage.has("key") }\n';
  const rows = inventorySource(path.join(app, 'inventory-fixture.vibe'), source);
  assert.deepEqual(rows.map(row => [row.label, row.category]), [
    ['query', 'effectful shell'], ['read', 'effectful shell'], ['write', 'effectful shell'],
    ['now', 'effectful shell'], ['pattern', 'pure logic'], ['member', 'pure logic'],
  ]);
});

test('a nested function\'s own boundary wins over its enclosing function\'s and the file\'s', () => {
  const file = path.join(app, 'worker/Accounts.vibe');
  const rows = inventorySource(file, fs.readFileSync(file, 'utf8'));
  // `make/presented` has its own entry; before the full-label lookup only the top-level `make` key was read.
  assert.match(rows.find(row => row.label === 'make/presented')?.why ?? '', /^Calls the proved presentedSession with the configured origin/);
  assert.match(rows.find(row => row.label === 'make/session')?.why ?? '', /^Calls the proved accountsDecision/);
});
