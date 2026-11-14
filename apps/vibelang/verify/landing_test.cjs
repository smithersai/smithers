const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { inventorySource, withTable } = require('./inventory.cjs');
const { refusals, treeFacts } = require('./landing.cjs');
const { branchFacts, rewritten, shellBranches } = require('./branches.cjs');
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

test('a runtime mutation whose source moved is refused', () => {
  const source = '// Fixture.\nexport const limit = 1\n';
  const line = 'runtime-usage-zero: worker/CallBudget.vibe holds its text 0 times, not once';
  assert.deepEqual(refusals({ ...facts(source), staleRuntime: [line] }), [`stale runtime mutation: ${line}`]);
});

test('a mutant that no longer typechecks is refused by name', () => {
  const source = '// Fixture.\nexport const limit = 1\n';
  const line = 'invalid mutant: actions-click-epoch (src/web/main.vibe update): x.ts(1,1): error TS2322: Type null is not assignable to type number.';
  assert.deepEqual(refusals({ ...facts(source), invalidMutants: [line] }), [line]);
});

test('a new branch in a shell row is refused until it is proved or recorded with a reason', () => {
  const shell = '// Fixture.\nexport function pick(role: string, n: number) {\n  if (role === "maintainer") return n\n  return n > 2 ? 1 : 0\n}\n';
  const rows = inventorySource(fixture, shell);
  assert.deepEqual(branchFacts(rows, '').refused.map(line => line.split(': prove')[0]), [
    'unrecorded branch: worker/landingFixture.vibe:3 pick', 'unrecorded branch: worker/landingFixture.vibe:4 pick']);
  const recorded = 'worker/landingFixture.vibe\tpick\trole === "maintainer"\tOpen: the maintainer rule\n'
    + 'worker/landingFixture.vibe\tpick\tn > 2\tHost boundary: the fixture\n';
  assert.deepEqual(branchFacts(rows, recorded), { refused: [], branches: 2, open: 1, stale: [] });
  // A second copy of a recorded condition is a new branch; a record with no reason is refused.
  const twice = shell.replace('return n > 2', 'if (n > 2) return 2\n  return n > 2');
  assert.equal(branchFacts(inventorySource(fixture, twice), recorded).refused.length, 1);
  assert.deepEqual(branchFacts(rows, recorded.replace('\tHost boundary: the fixture', '')).refused, ['branch record with no reason: worker/landingFixture.vibe\tpick\tn > 2']);
  // A condition that calls a proved function is not a shell branch; its record goes stale and --prune drops it.
  const proved = '//@ verify\n//@ ensures \\result == (role == "maintainer")\nexport function maintains(role: string): boolean {\n  return role === "maintainer"\n}\n'
    + shell.replace('role === "maintainer"', 'maintains(role)');
  const after = inventorySource(fixture, proved);
  assert.deepEqual(branchFacts(after, recorded), { refused: [], branches: 1, open: 0, stale: ['worker/landingFixture.vibe\tpick\trole === "maintainer"'] });
  assert.equal(rewritten(after, recorded).split('\n').filter(line => line && !line.startsWith('#')).length, 1);
  // Each operand counts: a proved call beside an unproved comparison leaves a branch; a flag bound to a proved call does not.
  const mixed = proved.replace('if (maintains(role))', 'if (maintains(role) && n > 1)')
    .replace('return n > 2 ? 1 : 0', 'const lead = maintains(role)\n  return !lead ? 1 : 0');
  assert.deepEqual(shellBranches(inventorySource(fixture, mixed)).map(branch => branch.test), ['maintains(role) && n > 1']);
  // A proved answer read against a literal is the proof's own value; a parameter compared with one is a decision.
  const answer = '//@ verify\n//@ ensures \\result == (n > 2 ? "big" : "small")\nexport function size(n: number): string {\n  return n > 2 ? "big" : "small"\n}\n'
    + '// Fixture.\nexport function use(n: number, kind: string) {\n  const s = size(n)\n  if (s === "big") return 1\n  if (s.length < 4) return 3\n  return kind === "big" ? 2 : 0\n}\n';
  assert.deepEqual(shellBranches(inventorySource(fixture, answer)).map(branch => branch.test), ['kind === "big"']);
  // A wrapper whose whole body returns a proved call decides nothing; a wrapper that adds a comparison does.
  const wrapped = answer + 'export function big(n: number) {\n  return size(n)\n}\nexport function bigger(n: number) {\n  return size(n) === "big" && n > 9\n}\n'
    + 'export function pick(n: number) {\n  if (big(n) === "big") return 1\n  return bigger(n) ? 2 : 0\n}\n';
  // Its own `&&` is a value choice too (batch 62: every kind counts in every file).
  assert.deepEqual(shellBranches(inventorySource(fixture, wrapped)).map(branch => branch.test), ['kind === "big"', '&& size(n) === "big" && n > 9', 'bigger(n)']);
  // A proved function called through a namespace decides too.
  const spaced = answer.replace('if (s === "big") return 1', 'if (Sizes.size(n) === "x" || Other.thing(n)) return 1');
  assert.deepEqual(shellBranches(inventorySource(fixture, spaced)).map(branch => branch.test), ['Sizes.size(n) === "x" || Other.thing(n)', 'kind === "big"']);
  // Presence, variant and host type tests decide nothing of their own; beside one, a comparison is still a branch.
  const guards = '// Fixture.\nexport function g(x: { _tag: string } | undefined, n: number) {\n  if (x === undefined || x._tag === "A" || !Number.isSafeInteger(n)) return 0\n  return typeof n === "number" && n > 1 ? 1 : 0\n}\n';
  assert.deepEqual(shellBranches(inventorySource(fixture, guards)).map(branch => branch.test), ['typeof n === "number" && n > 1']);
  // Moving a callback changes its label's line, not its record.
  const callback = '// Fixture.\nexport const f = (xs: number[]) => xs.map(x => x > 1 ? x : 0)\n';
  const k = 'worker/landingFixture.vibe\tf/callback\tx > 1\tOpen: fixture\n';
  assert.deepEqual(branchFacts(inventorySource(fixture, '\n\n' + callback), k).refused, []);
  // Views in src/web are in scope (0018, "Decisions in views"); a `??`, a `switch`, and an `&&` or `||` used as a
  // value choose too, in every file (batch 62).
  const web = path.join(app, 'src/web/landingFixture.vibe');
  assert.deepEqual(branchFacts(inventorySource(web, shell), '').branches, 2);
  const view = '// Fixture.\nexport function v(m: { label?: string, busy: boolean, kind: string }, ok: boolean) {\n  const label = m.label ?? "None"\n'
    + '  const off = m.busy || !ok\n  switch (m.kind) {\n    case "a": return 1\n  }\n  return [label, off, ok && "shown", ok ? 1 : 2]\n}\n';
  assert.deepEqual(shellBranches(inventorySource(web, view)).map(branch => branch.test), ['?? m.label', '|| m.busy || !ok', 'switch m.kind', '&& ok && "shown"', 'ok']);
  assert.deepEqual(shellBranches(inventorySource(fixture, view)).map(branch => branch.test), ['?? m.label', '|| m.busy || !ok', 'switch m.kind', '&& ok && "shown"', 'ok']);
});

// One read of the real tree (about 15 s): the inventory of every source, decision 0018 and mutations.py's cases.
const tree = treeFacts();

test('the tree on disk lands: no unproved row, a current 0018, a mutant for every contract, no stale case', () => {
  assert.deepEqual(refusals(tree), []);
});

test('adding a branch to a real shell row is refused', () => {
  const shell = tree.rows.find(row => row.file === 'worker/Accounts.vibe' && row.category === 'effectful shell');
  const extra = Object.defineProperty({ ...shell }, 'branches', { value: [...shell.branches, { line: 1, test: 'role === "owner"', operands: [{ calls: [], neutral: false, compared: 'role' }] }] });
  Object.defineProperty(extra, 'bindings', { value: shell.bindings });
  const rows = tree.rows.map(row => row === shell ? extra : row);
  assert.deepEqual(refusals({ ...tree, rows }).map(line => line.split(': prove')[0]), [`unrecorded branch: worker/Accounts.vibe:1 ${shell.label.replace(/@\d+/g, '')}`]);
});

test('adding an unproved decision to the real tree is refused', () => {
  const source = '// Fixture.\nexport function admitted(role: string): boolean {\n  return role === "maintainer"\n}\n';
  const rows = tree.rows.concat(inventorySource(fixture, source));
  assert.deepEqual(refusals({ ...tree, rows }), [
    'not proved: worker/landingFixture.vibe:2 admitted',
    'stale inventory: run node verify/inventory.cjs --write',
  ]);
});
