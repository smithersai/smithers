const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { inventorySource, withTable } = require('./inventory.cjs');
const { refusals, treeFacts } = require('./landing.cjs');
const app = path.resolve(__dirname, '..');
const fixture = path.join(app, 'worker/landingFixture.vibe');
const EMPTY = '# Fixture\n<!-- inventory:start -->\n<!-- inventory:end -->\n';

function facts(source, cases = []) {
  const rows = inventorySource(fixture, source);
  return { rows, decisionText: withTable(EMPTY, rows), cases };
}

test('an unproved decision is refused, by file, line and name', () => {
  const source = '// Fixture.\nexport function pick(xs: string[]) {\n  return xs.filter(x => x !== "")\n}\n';
  assert.deepEqual(refusals(facts(source)), [
    'not proved: worker/landingFixture.vibe:2 pick',
    'not proved: worker/landingFixture.vibe:3 pick/callback@3',
  ]);
});

test('a decision table that no longer matches the sources is refused', () => {
  const source = '//@ verify\n//@ ensures \\result === (x > 0)\nexport function positive(x: number): boolean {\n  return x > 0\n}\n';
  const current = facts(source, [['worker/landingFixture.vibe', 'positive', 'positive-sign']]);
  assert.deepEqual(refusals(current), []);
  assert.deepEqual(refusals({ ...current, decisionText: EMPTY }), ['stale inventory: run node verify/inventory.cjs --write']);
});

test('a contract with no mutant is refused; a lemma and a restated table need none', () => {
  const source = '//@ verify\n//@ ensures \\result === (x > 0)\nexport function positive(x: number): boolean {\n  return x > 0\n}\n'
    + '//@ verify\n//@ ensures \\result\nexport function holds(n: number): boolean {\n  return n <= 0 ? true : holds(n - 1)\n}\n'
    + '//@ verify\n//@ ensures \\result\nexport function always(n: number): boolean {\n  return true\n}\n'
    + '//@ verify\nexport function checked(x: number): number {\n  return x\n}\n';
  assert.deepEqual(refusals(facts(source)), ['no mutant: worker/landingFixture.vibe:3 positive']);
  const mutated = facts(source, [['worker/landingFixture.vibe', 'positive', 'positive-sign']]);
  assert.deepEqual(refusals(mutated), []);
  // A lemma's recursion must call itself: a call to another function is a decision.
  const other = '//@ verify\n//@ ensures \\result\nexport function step(n: number): boolean {\n  return n <= 0 ? true : other(n - 1)\n}\n';
  assert.deepEqual(refusals(facts(other)), ['no mutant: worker/landingFixture.vibe:3 step']);
});

test('a mutation case whose source moved is refused', () => {
  const source = '// Fixture.\nexport const limit = 1\n';
  assert.deepEqual(refusals({ ...facts(source), staleCases: ['gone: missing function gone in worker/x.vibe'] }),
    ['stale mutation: gone: missing function gone in worker/x.vibe']);
});

// One read of the real tree (about 15 s): the inventory of every source, decision 0018 and mutations.py's cases.
const tree = treeFacts();

test('the tree on disk lands: no unproved row, a current 0018, a mutant for every contract, no stale case', () => {
  assert.deepEqual(refusals(tree), []);
});

test('adding an unproved decision to the real tree is refused', () => {
  const source = '// Fixture.\nexport function admitted(role: string): boolean {\n  return role === "maintainer"\n}\n';
  const rows = tree.rows.concat(inventorySource(fixture, source));
  assert.deepEqual(refusals({ ...tree, rows }), [
    'not proved: worker/landingFixture.vibe:2 admitted',
    'stale inventory: run node verify/inventory.cjs --write',
  ]);
});
