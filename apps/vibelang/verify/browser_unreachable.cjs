// Stays .cjs: verify/landing.cjs requires it synchronously, as it requires inventory.cjs.
//
// The browser gate's list of counters no page can run (decision 0016, "Browser-unreachable counters"). 0016's tables
// are the source: each counter names the page check that refuses its input first and the unit or Worker test that runs
// it. `verify/browser-unreachable.tsv` is generated from them for the gate (test/support/browserVerdict.vibe), so the
// two cannot drift: `--write` regenerates it, `--check` and the landing check refuse a stale or malformed list.
const fs = require('node:fs');
const path = require('node:path');
const app = path.resolve(__dirname, '..');
const decision = path.join(app, 'wiki/decisions/0016-coverage.md');
const list = path.join(app, 'verify/browser-unreachable.tsv');
const SECTION = '## Browser-unreachable counters';
const HEADER = ['file', 'line', 'column', 'kind', 'index', 'count', 'reason', 'check', 'test', 'test_line'];
const COUNTER = /^`([^`:\s]+\.vibe):(\d+):(\d+) (branch (\d+)|statement|function)`(?: ×(\d+))?$/;
const TEST = /^`(test\/[^`:\s]+):(\d+)`$/;
// A test declaration as Vitest reports its location: `it(`, `test(`, `it.effect(`, `it.live(` and the like, or the
// line that calls an `it.each([...])` table with its name, where Vitest puts each row's test: `] as const)("%s", …`.
const DECLARATION = /(^|[^\w.])(it|test)(\.\w+)*\s*\(|\)\s*\(\s*["'`]/;

/** The cells of a Markdown table row, or undefined for a line that is not one. */
function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined;
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

/** The section's text: from its heading to the next second-level heading. */
function section(text) {
  const start = text.indexOf(`\n${SECTION}`);
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', SECTION.length);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The rows 0016's section holds and every refusal of a malformed one. A reasons table's header is `| Reason | ... |`,
 * a counters table's `| Counter | Reason | Test |`; any number of each, so each lane keeps its own subsection.
 */
function parse(text) {
  const body = section(text);
  if (body === undefined) return { rows: [], refused: [`no "${SECTION}" section in 0016`] };
  const reasons = new Map();
  const counters = [];
  const refused = [];
  let table;
  for (const [offset, line] of body.split('\n').entries()) {
    const row = cells(line);
    if (row === undefined) { table = undefined; continue; }
    if (table === undefined) { table = row[0] === 'Reason' ? 'reasons' : row[0] === 'Counter' ? 'counters' : 'other'; continue; }
    if (row.every(cell => /^:?-+:?$/.test(cell))) continue;
    if (table === 'reasons') {
      const id = /^`([a-z0-9-]+)`$/.exec(row[0] ?? '');
      if (!id || row.length !== 2 || row[1] === '') refused.push(`malformed reason row: ${line.trim()}`);
      else if (reasons.has(id[1])) refused.push(`reason listed twice: ${id[1]}`);
      else reasons.set(id[1], row[1]);
    } else if (table === 'counters') counters.push({ row, line: line.trim(), offset });
  }
  const rows = [];
  const seen = new Set();
  for (const { row, line } of counters) {
    const counter = COUNTER.exec(row[0] ?? '');
    const reason = /^`([a-z0-9-]+)`$/.exec(row[1] ?? '');
    const test = TEST.exec(row[2] ?? '');
    if (row.length !== 3 || !counter || !reason || !test) { refused.push(`malformed counter row: ${line}`); continue; }
    const [, file, lineNumber, column, kindText, index] = counter;
    const kind = kindText.split(' ')[0];
    const key = `${file}:${lineNumber}:${column} ${kind} ${index ?? 0}`;
    if (seen.has(key)) { refused.push(`counter listed twice (write ×N): ${key}`); continue; }
    seen.add(key);
    if (!reasons.has(reason[1])) { refused.push(`unknown reason ${reason[1]}: ${key}`); continue; }
    rows.push({
      file, line: Number(lineNumber), column: Number(column), kind, index: Number(index ?? 0), count: Number(counter[6] ?? 1),
      reason: reason[1], check: reasons.get(reason[1]), test: test[1], testLine: Number(test[2]),
    });
  }
  return { rows, refused };
}

/** The list's text for these rows: a header, then one row per counter in 0016's order. */
function tsv(rows) {
  const clean = value => String(value).replace(/[\t\n]/g, ' ');
  return [HEADER, ...rows.map(row => [row.file, row.line, row.column, row.kind, row.index, row.count, row.reason, row.check, row.test, row.testLine])]
    .map(fields => fields.map(clean).join('\t')).join('\n') + '\n';
}

/** Every named test that is not a test declaration on its line, read from the tree under `root`. */
function testRefusals(rows, root = app) {
  const refused = [];
  const texts = new Map();
  for (const row of rows) {
    if (!texts.has(row.test)) texts.set(row.test, fs.existsSync(path.join(root, row.test)) ? fs.readFileSync(path.join(root, row.test), 'utf8').split('\n') : undefined);
    const lines = texts.get(row.test);
    if (lines === undefined) refused.push(`missing test file ${row.test}: ${row.file}:${row.line}:${row.column} ${row.kind} ${row.index}`);
    else if (!DECLARATION.test(lines[row.testLine - 1] ?? '')) refused.push(`no test declared at ${row.test}:${row.testLine}: ${row.file}:${row.line}:${row.column} ${row.kind} ${row.index}`);
  }
  return refused;
}

/** Every reason the list may not land: a malformed 0016 row, a named test that is not one, or a stale list. */
function refusals({ decisionText, listText, root = app }) {
  const { rows, refused } = parse(decisionText);
  refused.push(...testRefusals(rows, root));
  if (listText !== tsv(rows)) refused.push('stale browser-unreachable list: run node verify/browser_unreachable.cjs --write');
  return refused;
}

/** The facts for the tree on disk. */
function treeFacts() {
  return { decisionText: fs.readFileSync(decision, 'utf8'), listText: fs.existsSync(list) ? fs.readFileSync(list, 'utf8') : '' };
}

function main(argv) {
  const facts = treeFacts();
  if (argv.includes('--write')) {
    const { rows, refused } = parse(facts.decisionText);
    if (refused.length) { console.error(refused.join('\n')); process.exitCode = 1; return; }
    fs.writeFileSync(list, tsv(rows));
    console.log(`browser-unreachable list: ${rows.length} counters written`);
    return;
  }
  const refused = refusals(facts);
  console.log(`browser-unreachable list: ${parse(facts.decisionText).rows.length} counters, ${refused.length} refused`);
  if (refused.length) { console.error(refused.join('\n')); process.exitCode = 1; }
}

module.exports = { parse, tsv, refusals, testRefusals, treeFacts, HEADER };
if (require.main === module) main(process.argv.slice(2));
