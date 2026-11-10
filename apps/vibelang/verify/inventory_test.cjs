const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { inventorySource } = require('./inventory.cjs');
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
  assert.equal(inventorySource(decision, fs.readFileSync(decision, 'utf8')).find(row => row.label === 'unansweredIndexes')?.category, 'pure logic');
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
