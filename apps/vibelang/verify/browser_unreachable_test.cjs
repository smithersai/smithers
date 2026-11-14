const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parse, tsv, refusals, testRefusals, treeFacts } = require('./browser_unreachable.cjs');

const SECTION = [
  '# Coverage', '', '## Browser-unreachable counters', '', 'Prose.', '',
  '| Reason | The page check that refuses the input first |', '| --- | --- |',
  '| `spec-only` | Specification only: nothing calls it at run time. |',
  '| `mock-ids` | The mock builds every id itself. |', '',
  '| Counter | Reason | Test |', '| --- | --- | --- |',
  '| `src/core/a.vibe:12:4 branch 1` | `spec-only` | `test/a.test.vibe:3` |',
  '| `src/core/a.vibe:13:2 statement` ×2 | `mock-ids` | `test/a.test.vibe:7` |',
  '| `src/core/b.vibe:5:16 function` | `spec-only` | `test/b.test.vibe:3` |', '',
  '## Next section', '', '| Counter | Reason | Test |', '| --- | --- | --- |', '| not | read | here |', '',
].join('\n');

function root(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreachable-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const TESTS = { 'test/a.test.vibe': 'import { it } from "vitest"\n\nit("one", () => {})\n\n\n\nit.effect("two", () => Effect.void)\n', 'test/b.test.vibe': 'it.each([\n  ["x", 1],\n] as const)("three %s", (_name, n) => {})\n' };

test('each counter row becomes one list row with its reason text, count and named test', () => {
  const { rows, refused } = parse(SECTION);
  assert.deepEqual(refused, []);
  assert.deepEqual(rows.map(row => [row.file, row.line, row.column, row.kind, row.index, row.count, row.reason, row.test, row.testLine]), [
    ['src/core/a.vibe', 12, 4, 'branch', 1, 1, 'spec-only', 'test/a.test.vibe', 3],
    ['src/core/a.vibe', 13, 2, 'statement', 0, 2, 'mock-ids', 'test/a.test.vibe', 7],
    ['src/core/b.vibe', 5, 16, 'function', 0, 1, 'spec-only', 'test/b.test.vibe', 3],
  ]);
  assert.equal(tsv(rows).split('\n')[1], 'src/core/a.vibe\t12\t4\tbranch\t1\t1\tspec-only\tSpecification only: nothing calls it at run time.\ttest/a.test.vibe\t3');
});

test('a malformed row, an unknown reason and a counter listed twice are refused', () => {
  const bad = SECTION
    .replace('| `src/core/b.vibe:5:16 function` | `spec-only` |', '| `src/core/b.vibe:5:16 function` | `nowhere` |')
    .replace('| `mock-ids` | The mock', '| mock-ids | The mock')
    .replace('| `src/core/a.vibe:13:2 statement` ×2 |', '| `src/core/a.vibe:12:4 branch 1` |');
  assert.deepEqual(parse(bad).refused, [
    'malformed reason row: | mock-ids | The mock builds every id itself. |',
    'counter listed twice (write ×N): src/core/a.vibe:12:4 branch 1',
    'unknown reason nowhere: src/core/b.vibe:5:16 function 0',
  ]);
  assert.deepEqual(parse('# No section\n').refused, ['no "## Browser-unreachable counters" section in 0016']);
});

test('a named test that is missing or not declared on its line is refused', () => {
  const { rows } = parse(SECTION);
  assert.deepEqual(testRefusals(rows, root(TESTS)), []);
  const moved = root({ ...TESTS, 'test/a.test.vibe': TESTS['test/a.test.vibe'].replace('it("one"', '\nit("one"') });
  assert.deepEqual(testRefusals(rows, moved), [
    'no test declared at test/a.test.vibe:3: src/core/a.vibe:12:4 branch 1',
    'no test declared at test/a.test.vibe:7: src/core/a.vibe:13:2 statement 0',
  ]);
  assert.deepEqual(testRefusals(rows, root({ 'test/a.test.vibe': TESTS['test/a.test.vibe'] })), ['missing test file test/b.test.vibe: src/core/b.vibe:5:16 function 0']);
  // A table's own rows are not declarations: line 2 of b is a row.
  assert.deepEqual(testRefusals([{ ...rows[2], testLine: 2 }], root(TESTS)), ['no test declared at test/b.test.vibe:2: src/core/b.vibe:5:16 function 0']);
});

test('a list that differs from 0016 is stale and refused', () => {
  const dir = root(TESTS);
  const listText = tsv(parse(SECTION).rows);
  assert.deepEqual(refusals({ decisionText: SECTION, listText, root: dir }), []);
  const edited = SECTION.replace('`test/b.test.vibe:3`', '`test/a.test.vibe:3`');
  assert.deepEqual(refusals({ decisionText: edited, listText, root: dir }), ['stale browser-unreachable list: run node verify/browser_unreachable.cjs --write']);
});

test("the tree's list matches 0016 and names declared tests", () => {
  assert.deepEqual(refusals(treeFacts()), []);
});
