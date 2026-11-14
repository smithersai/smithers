// `pnpm fuzz:affected` and the landing check's receipt rule (decision 0015, "Fuzz before landing").
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { main, closure, emittedPrograms, suite, select, hashes, changedFiles, landingRefusals, receiptRefusals, readReceipts, shortfalls, RECEIPT_VERSION } = require('./fuzz_affected.cjs');

/** A throwaway app: each key is a path, each value its text. */
function app(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-affected-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const FIXTURE = {
  'fuzz/a.fuzz.vibe': 'import { x } from "../src/x.vibe"\nconst api = new URL("../test/host.vibe", import.meta.url)\n',
  'fuzz/browser.spec.ts': 'import "./browser-target.vibe"\n',
  'fuzz/browser-target.vibe': '',
  'index.html': '<script type="module" src="/src/web/entry.vibe"></script>\n',
  'test/host.vibe': 'const bundled = bundle("../worker/Api.vibe")\nconst cli = new URL("../dist-factory/surfaces/cli.js", import.meta.url)\n',
  'tsconfig.surfaces.json': '{ "compilerOptions": { "rootDir": "src", "outDir": "dist-factory" }, "include": ["src/surfaces"] }\n',
  'src/x.vibe': 'export { y } from "./y.vibe"\nexport const x = 1\n',
  'src/y.vibe': 'export const y = 2\n',
  'src/surfaces/cli.vibe': 'export const cli = 3\n',
  'src/web/entry.vibe': 'import "./view.vibe"\n',
  'src/web/view.vibe': '',
  'src/orphan.vibe': 'export const nobody = 4\n',
  'worker/Api.vibe': '',
};

const reached = root => {
  const cache = new Map();
  return suite(root).map(target => ({ ...target, reaches: closure(root, target.roots, cache, emittedPrograms(root)) }));
};

test('a target reaches a source through imports, re-exports, URLs, worker bundles and emitted programs', () => {
  const root = app(FIXTURE);
  const [fuzz, browser] = reached(root);
  assert.equal(fuzz.name, 'fuzz/a.fuzz.vibe');
  for (const file of ['src/x.vibe', 'src/y.vibe', 'worker/Api.vibe', 'src/surfaces/cli.vibe']) assert.ok(fuzz.reaches.has(file), file);
  assert.ok(!fuzz.reaches.has('src/web/view.vibe'));
  assert.equal(browser.kind, 'browser');
  assert.ok(browser.reaches.has('src/web/view.vibe'), 'the browser phase reaches the site index.html builds');
});

test('a changed source that no target imports is reported, and selects nothing for itself', () => {
  const { selected, unreached } = select(['src/y.vibe', 'src/orphan.vibe'], reached(app(FIXTURE)));
  assert.deepEqual(selected.map(target => target.name), ['fuzz/a.fuzz.vibe']);
  assert.deepEqual(unreached, ['src/orphan.vibe']);
});

test('fuzz:affected fails, before running anything, when a changed source has no target', () => {
  const root = app(FIXTURE);
  const errors = [];
  const original = console.error;
  console.error = line => errors.push(String(line));
  let status;
  try { status = main([], { FUZZ_AFFECTED_FILES: 'src/y.vibe src/orphan.vibe' }, root); } finally { console.error = original; }
  assert.equal(status, 1);
  assert.match(errors.join('\n'), /no fuzz target imports 1 changed source\(s\)[\s\S]*src\/orphan\.vibe/);
  assert.ok(!fs.existsSync(path.join(root, 'fuzz-results')), 'no receipt for a run that never started');
});

test('fuzz:affected passes with nothing to fuzz when no measured source changed', () => {
  assert.equal(main([], { FUZZ_AFFECTED_FILES: 'README.md src/missing.vibe' }, app(FIXTURE)), 0);
});

const receipt = (files, result = 'passed') => ({ version: RECEIPT_VERSION, result, files, targets: ['fuzz/a.fuzz.vibe'] });

test('a receipt for other contents is refused, naming each file', () => {
  const root = app(FIXTURE);
  const current = hashes(root, ['src/x.vibe', 'src/y.vibe']);
  const stale = receipt({ ...current, 'src/y.vibe': 'f'.repeat(64) });
  assert.deepEqual(receiptRefusals(current, [stale]), [
    'no passing fuzz receipt for these contents: run pnpm fuzz:affected (2 changed source(s))',
    '  changed since its receipt: src/x.vibe',
    '  changed since its receipt: src/y.vibe',
  ]);
  assert.match(receiptRefusals(current, [])[1], /never fuzzed: src\/x\.vibe/);
});

test('a failed receipt, or one that covers only some of the files, is refused', () => {
  const current = hashes(app(FIXTURE), ['src/x.vibe', 'src/y.vibe']);
  assert.equal(receiptRefusals(current, [receipt(current, 'failed')]).length, 3);
  assert.equal(receiptRefusals(current, [receipt({ 'src/x.vibe': current['src/x.vibe'] }), receipt({ 'src/y.vibe': current['src/y.vibe'] })]).length, 3);
});

test('a passing receipt for exactly these contents passes, and so does a range with no measured source', () => {
  const root = app(FIXTURE);
  const current = hashes(root, ['src/x.vibe']);
  const directory = path.join(root, 'fuzz-results', 'affected');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'broken.json'), '{');
  fs.writeFileSync(path.join(directory, 'one.json'), JSON.stringify(receipt({ ...current, 'src/y.vibe': 'other' })));
  assert.deepEqual(receiptRefusals(current, readReceipts(directory)), []);
  assert.deepEqual(receiptRefusals({}, []), []);
});

test('every changed file must be at 100% on all four metrics, and in the report', () => {
  const full = { total: 2, covered: 2, pct: 100 };
  const summary = { '/app/src/x.vibe': { lines: full, branches: { total: 4, covered: 3, pct: 75 }, functions: full, statements: full } };
  assert.deepEqual(shortfalls('/app', ['src/x.vibe', 'src/y.vibe'], summary), ['src/x.vibe branches: 3/4', 'src/y.vibe: not in the fuzz report']);
});

test('the changed sources are the measured files jj diff names under the app, deleted ones left out', () => {
  const root = app({ 'apps/site/src/kept.vibe': 'a\n', 'apps/site/src/gone.vibe': 'b\n', 'apps/site/README.md': 'c\n' });
  const jj = (...args) => {
    const run = spawnSync('jj', args, { cwd: root, encoding: 'utf8', env: { ...process.env, JJ_CONFIG: '', JJ_USER: 'fixture', JJ_EMAIL: 'fixture@example.com' } });
    assert.equal(run.status, 0, run.stderr);
  };
  jj('git', 'init');
  jj('bookmark', 'create', 'main', '-r', '@');
  jj('new');
  fs.writeFileSync(path.join(root, 'apps/site/src/kept.vibe'), 'changed\n');
  fs.mkdirSync(path.join(root, 'apps/site/worker'));
  fs.writeFileSync(path.join(root, 'apps/site/worker/added.vibe'), 'new\n');
  fs.rmSync(path.join(root, 'apps/site/src/gone.vibe'));
  fs.writeFileSync(path.join(root, 'apps/site/README.md'), 'changed\n');
  assert.deepEqual(changedFiles(path.join(root, 'apps/site'), 'main'), ['src/kept.vibe', 'worker/added.vibe']);
});

test('outside a jj repository the landing check refuses with one line, not a stack trace', () => {
  const verdict = landingRefusals(app(FIXTURE));
  assert.equal(verdict.receipt, 'missing');
  assert.equal(verdict.refused.length, 1);
  assert.match(verdict.refused[0], /^fuzz receipt: jj diff failed: /);
});

test('the landing verdict is not needed, matched or missing', () => {
  const root = app({ 'apps/site/src/kept.vibe': 'a\n' });
  const site = path.join(root, 'apps/site');
  const jj = (...args) => assert.equal(spawnSync('jj', args, { cwd: root, encoding: 'utf8', env: { ...process.env, JJ_USER: 'fixture', JJ_EMAIL: 'fixture@example.com' } }).status, 0);
  jj('git', 'init');
  jj('bookmark', 'create', 'main', '-r', '@');
  jj('new');
  assert.deepEqual(landingRefusals(site, 'main'), { receipt: 'not needed', refused: [] });
  fs.writeFileSync(path.join(site, 'src/kept.vibe'), 'changed\n');
  assert.equal(landingRefusals(site, 'main').receipt, 'missing');
  const directory = path.join(site, 'fuzz-results', 'affected');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'r.json'), JSON.stringify(receipt(hashes(site, ['src/kept.vibe']))));
  assert.deepEqual(landingRefusals(site, 'main'), { receipt: 'matched', refused: [] });
});

/** A flow stand-in that writes what the real one does: intermediate reports, build output, the merged summary. */
const writesReports = (summary, extra = {}) => root => {
  const files = {
    'coverage/fuzz-unit/coverage-final.json': '{}', 'coverage/fuzz-unit/workerd-raw/0.json': '{}',
    'coverage/fuzz-browser/coverage-final.json': '{}', 'coverage/fuzz/coverage-final.json': '{}',
    'coverage/fuzz/src/y.vibe.html': '<html>', 'coverage/fuzz/coverage-summary.json': JSON.stringify(summary),
    'dist-factory/surfaces/cli.js': '', 'fuzz/test-results/browser-random/trace.zip': 'zip', ...extra,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return 0;
};
const full = { total: 1, covered: 1, pct: 100 };
const line = (pct) => ({ lines: { total: 2, covered: pct === 100 ? 2 : 1, pct }, branches: full, functions: full, statements: full });
const quietly = run => {
  const saved = [console.log, console.error];
  console.log = console.error = () => {};
  try { return run(); } finally { [console.log, console.error] = saved; }
};

test('a passing run keeps its receipt and summary, and deletes the intermediate reports', () => {
  const root = app({ ...FIXTURE, 'coverage/fuzz-unit/stale.json': 'an older run' });
  const status = quietly(() => main([], { FUZZ_AFFECTED_FILES: 'src/y.vibe' }, root, (r) => writesReports({ [path.join(r, 'src/y.vibe')]: line(100) })(r)));
  assert.equal(status, 0);
  const left = [...require('./fuzz_affected.cjs').treeFiles(root)].filter(file => !(file in FIXTURE)).sort();
  assert.deepEqual(left.filter(file => !file.startsWith('fuzz-results/')), ['coverage/fuzz/coverage-summary.json', 'dist-factory/surfaces/cli.js']);
  assert.equal(left.filter(file => file.startsWith('fuzz-results/affected/')).length, 1);
});

test('--results-only also deletes every file the run made, but keeps new regressions and everything already there', () => {
  const root = app({ ...FIXTURE, 'dist-scripts/old.js': 'built before' });
  const status = quietly(() => main(['--results-only'], { FUZZ_AFFECTED_FILES: 'src/y.vibe' }, root,
    (r) => writesReports({ [path.join(r, 'src/y.vibe')]: line(100) }, { 'fuzz/__fuzz__/new-regression': '[]' })(r)));
  assert.equal(status, 0);
  const left = [...require('./fuzz_affected.cjs').treeFiles(root)].filter(file => !(file in FIXTURE) && !file.startsWith('fuzz-results/')).sort();
  assert.deepEqual(left, ['coverage/fuzz/coverage-summary.json', 'dist-scripts/old.js', 'fuzz/__fuzz__/new-regression']);
  assert.ok(!fs.existsSync(path.join(root, 'dist-factory')), 'emptied directories go too');
});

test('a failing run keeps the merged report and the failure traces for the failing file', () => {
  const root = app(FIXTURE);
  const status = quietly(() => main(['--results-only'], { FUZZ_AFFECTED_FILES: 'src/y.vibe' }, root, (r) => writesReports({ [path.join(r, 'src/y.vibe')]: line(50) })(r)));
  assert.equal(status, 1);
  const left = [...require('./fuzz_affected.cjs').treeFiles(root)].filter(file => !(file in FIXTURE) && !file.startsWith('fuzz-results/')).sort();
  assert.deepEqual(left, ['coverage/fuzz/coverage-final.json', 'coverage/fuzz/coverage-summary.json', 'coverage/fuzz/src/y.vibe.html', 'fuzz/test-results/browser-random/trace.zip']);
});

test('the surfaces build runs only for targets that reach its output directory', () => {
  const { needsSurfaces } = require('./fuzz_affected.cjs');
  const root = app(FIXTURE);
  const [fuzz, browser] = reached(root);
  assert.equal(needsSurfaces(root, fuzz.reaches), true, 'test/host.vibe names dist-factory/surfaces/cli.js');
  assert.equal(needsSurfaces(root, browser.reaches), false);
  const seen = [];
  quietly(() => main([], { FUZZ_AFFECTED_FILES: 'src/y.vibe' }, root, (r, env, plan) => { seen.push(plan.surfaces); return 1; }));
  assert.deepEqual(seen, [true]);
});

test('the plan gives the browser phase its own shard and packs the Vitest targets longest first near the budget', () => {
  const { plan } = require('./fuzz_affected.cjs');
  const selected = [{ name: 'fuzz/a.fuzz.vibe', kind: 'vitest' }, { name: 'fuzz/b.fuzz.vibe', kind: 'vitest' }, { name: 'fuzz/c.fuzz.vibe', kind: 'vitest' }, { name: 'browser', kind: 'browser' }];
  const costs = { 'fuzz/a.fuzz.vibe': 80, 'fuzz/b.fuzz.vibe': 50, 'fuzz/c.fuzz.vibe': 10, browser: 100 };
  assert.deepEqual(plan(selected, costs, 8).map(({ vitest, browser }) => ({ vitest, browser })), [
    { vitest: [], browser: true }, { vitest: ['fuzz/a.fuzz.vibe'], browser: false }, { vitest: ['fuzz/b.fuzz.vibe', 'fuzz/c.fuzz.vibe'], browser: false },
  ]);
  assert.deepEqual(plan(selected, costs, 2).map(shard => shard.vitest.length), [0, 3], 'never more shards than boxes');
  assert.deepEqual(plan(selected.slice(0, 3), costs, 1).map(shard => shard.vitest.length), [3]);
});

const fileReport = (s, f = [1], b = [[1, 0]]) => ({
  path: 'src/y.vibe', statementMap: Object.fromEntries(s.map((_, i) => [i, { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 5 } }])),
  fnMap: { 0: { name: 'y', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } } },
  branchMap: { 0: { type: 'if', loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, locations: [{ start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }, { start: {}, end: {} }] } },
  s: Object.fromEntries(s.map((hits, i) => [i, hits])), f: { 0: f[0] }, b: { 0: b[0] },
});

test('shards add their hits on one structure, and a structure that differs is refused', () => {
  const { mergeShards, metricsOf } = require('./fuzz_affected.cjs');
  const { merged, refused } = mergeShards(['src/y.vibe'], [{ 'src/y.vibe': fileReport([1, 0], [1], [[1, 0]]) }, { 'src/y.vibe': fileReport([0, 2], [0], [[0, 3]]) }]);
  assert.deepEqual(refused, []);
  assert.deepEqual(merged['src/y.vibe'].s, { 0: 1, 1: 2 });
  assert.deepEqual(merged['src/y.vibe'].b, { 0: [1, 3] });
  assert.deepEqual(Object.values(metricsOf(merged['src/y.vibe'])).map(metric => metric.pct), [100, 100, 100, 100]);
  const other = mergeShards(['src/y.vibe'], [{ 'src/y.vibe': fileReport([1, 0]) }, { 'src/y.vibe': fileReport([1, 1, 1]) }]);
  assert.deepEqual(other.refused, ['src/y.vibe: the shards\' reports disagree on its structure']);
  assert.deepEqual(mergeShards(['src/y.vibe'], [{}]).refused, ['src/y.vibe: not in any shard\'s report']);
});

/** A box stand-in: runs each shard's command as its own fuzz:affected would, writing the shard's result file. */
const boxesThatReturn = (root, coverageFor, exits = []) => async commands => commands.map(({ command }, index) => {
  // The shard's command is the template's last argument, single-quoted for bash.
  const inner = command.slice(command.indexOf(" '") + 2, -1).replace(/'\\''/g, "'");
  const shard = JSON.parse(/FUZZ_AFFECTED_SHARD='([^']+)'/.exec(inner)[1]);
  const file = path.join(root, `fuzz-results/shards/${shard.run}/${shard.index}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const files = /FUZZ_AFFECTED_FILES='([^']*)'/.exec(inner)[1].split(' ');
  fs.writeFileSync(file, JSON.stringify({ version: RECEIPT_VERSION, run: shard.run, index: shard.index, files: hashes(root, files), vitest: shard.vitest, browser: shard.browser, flowExit: exits[index] ?? 0, coverage: coverageFor(index), elapsedMs: 1000 }));
  return exits[index] ?? 0;
});

test('--boxes runs a shard per box, sums their reports and writes one receipt; one shard short of 100% fails it', async () => {
  const twoTargets = { ...FIXTURE, 'fuzz/b.fuzz.vibe': 'import "../src/y.vibe"\n', 'verify/fuzz_costs.json': JSON.stringify({ seconds: { 'fuzz/a.fuzz.vibe': 80, 'fuzz/b.fuzz.vibe': 80 } }) };
  const root = app(twoTargets);
  const env = { FUZZ_AFFECTED_FILES: 'src/y.vibe', FUZZ_AFFECTED_BOX: 'box --name {name} --' };
  const halves = index => ({ 'src/y.vibe': index === 0 ? fileReport([1, 0], [1], [[1, 0]]) : fileReport([0, 1], [0], [[0, 1]]) });
  let seen;
  const status = await quietly(() => main(['--boxes', '4'], env, root, undefined, async commands => { seen = commands; return boxesThatReturn(root, halves)(commands); }));
  assert.equal(status, 0);
  assert.equal(seen.length, 2);
  assert.match(seen[0].command, /^box --name fuzz-affected-0 -- 'node verify\/fuzz_affected\.cjs --snapshot \/tmp\/fuzz-affected-before\.json && cd \. && pnpm install --frozen-lockfile .* pnpm fuzz:affected --results-only'$/);
  const receipts = readReceipts(path.join(root, 'fuzz-results', 'affected'));
  assert.deepEqual(receipts.map(receipt => [receipt.result, receipt.targets.sort(), receipt.shards.length]), [['passed', ['fuzz/a.fuzz.vibe', 'fuzz/b.fuzz.vibe'], 2]]);
  const short = app(twoTargets);
  assert.equal(await quietly(() => main(['--boxes', '4'], env, short, undefined, boxesThatReturn(short, () => ({ 'src/y.vibe': fileReport([1, 0]) })))), 1);
  assert.deepEqual(readReceipts(path.join(short, 'fuzz-results', 'affected')).map(receipt => receipt.below), [['src/y.vibe lines: 1/2', 'src/y.vibe branches: 1/2', 'src/y.vibe statements: 1/2']]);
});

test('--boxes refuses without its box command, and a shard that failed or never returned fails the receipt', async () => {
  const root = app(FIXTURE);
  assert.equal(await quietly(() => main(['--boxes', '2'], { FUZZ_AFFECTED_FILES: 'src/y.vibe' }, root)), 1);
  assert.ok(!fs.existsSync(path.join(root, 'fuzz-results', 'affected')));
  const env = { FUZZ_AFFECTED_FILES: 'src/y.vibe', FUZZ_AFFECTED_BOX: 'box --' };
  assert.equal(await quietly(() => main(['--boxes', '2'], env, root, undefined, boxesThatReturn(root, () => ({ 'src/y.vibe': fileReport([1]) }), [1]))), 1);
  assert.deepEqual(readReceipts(path.join(root, 'fuzz-results', 'affected')).map(receipt => [receipt.result, receipt.below]), [['failed', ['shard 0: the fuzz flow failed']]]);
  const lost = app(FIXTURE);
  assert.equal(await quietly(() => main(['--boxes', '2'], env, lost, undefined, async commands => commands.map(() => 255))), 1);
  assert.deepEqual(readReceipts(path.join(lost, 'fuzz-results', 'affected'))[0].below, ['shard 0 returned no result', 'no shard ran fuzz/a.fuzz.vibe']);
});

test('a shard runs exactly its targets, gates nothing, and keeps only its result file', () => {
  const root = app(FIXTURE);
  const shard = { run: 'r1', index: 3, vitest: ['fuzz/a.fuzz.vibe'], browser: false };
  let plan;
  const status = quietly(() => main(['--results-only'], { FUZZ_AFFECTED_FILES: 'src/y.vibe', FUZZ_AFFECTED_SHARD: JSON.stringify(shard) }, root, (r, env, given) => {
    plan = { ...given, shard: env.FUZZ_SHARD };
    return writesReports({})(r);
  }));
  assert.equal(status, 0);
  assert.deepEqual([plan.vitest, plan.browser, plan.shard], [['fuzz/a.fuzz.vibe'], false, '1']);
  const left = [...require('./fuzz_affected.cjs').treeFiles(root)].filter(file => !(file in FIXTURE)).sort();
  assert.deepEqual(left, ['fuzz-results/shards/r1/3.json']);
  assert.ok(!fs.existsSync(path.join(root, 'fuzz-results', 'affected')), 'a shard writes no receipt');
});

test('target costs come from Vitest\'s per-file lines and Playwright\'s total', () => {
  const { costsFromLogs } = require('./fuzz_affected.cjs');
  const vitest = ' \x1b[32m✓\x1b[39m \x1b[30m\x1b[46m fuzz \x1b[49m\x1b[39m fuzz/web.fuzz.vibe \x1b[2m(\x1b[22m\x1b[2m5 tests\x1b[22m\x1b[2m)\x1b[22m\x1b[33m 54291\x1b[2mms\x1b[22m\x1b[39m\n';
  const node = ' ✓  fuzz-node  fuzz/scripts.node.fuzz.vibe (1 test) 57579ms\n';
  assert.deepEqual(costsFromLogs([vitest + node, '  5 passed (4.2m)\n']), { 'fuzz/web.fuzz.vibe': 54.3, 'fuzz/scripts.node.fuzz.vibe': 57.6, browser: 252 });
});

test('--results-only measures from a snapshot taken before the install, so the install\'s files go too', () => {
  const root = app(FIXTURE);
  const before = path.join(root, '..', `${path.basename(root)}-before.json`);
  assert.equal(main(['--snapshot', before], {}, root), 0);
  fs.mkdirSync(path.join(root, 'packages/x/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/x/dist/index.js'), 'installed');
  const status = quietly(() => main(['--results-only'], { FUZZ_AFFECTED_FILES: 'src/y.vibe', FUZZ_AFFECTED_BEFORE: before }, root, (r) => writesReports({ [path.join(r, 'src/y.vibe')]: line(100) })(r)));
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(path.join(root, 'packages/x/dist/index.js')));
});

test('the browser shard runs the browser phase alone, and the host credits its report by source position', async () => {
  const shardRoot = app(FIXTURE);
  let given;
  const status = quietly(() => main(['--results-only'], { FUZZ_AFFECTED_FILES: 'src/web/view.vibe', FUZZ_AFFECTED_SHARD: JSON.stringify({ run: 'r', index: 0, vitest: [], browser: true }) }, shardRoot,
    (r, env, plan) => { given = plan; return writesReports({}, { 'coverage/fuzz-browser/coverage-final.json': JSON.stringify({ [path.join(r, 'src/web/view.vibe')]: fileReport([1]) }) })(r); }));
  assert.equal(status, 0);
  assert.deepEqual([given.vitest, given.browser, given.unit], [[], true, false]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(shardRoot, 'fuzz-results/shards/r/0.json'), 'utf8')).coverage), ['src/web/view.vibe']);

  const root = app({ ...FIXTURE, 'fuzz/a.fuzz.vibe': FIXTURE['fuzz/a.fuzz.vibe'] + 'import "../src/web/view.vibe"\n' });
  const env = { FUZZ_AFFECTED_FILES: 'src/web/view.vibe', FUZZ_AFFECTED_BOX: 'box --image {image} --' };
  const node = { 'src/web/view.vibe': fileReport([1, 0], [1], [[1, 1]]) };
  const chromium = { 'src/web/view.vibe': fileReport([0, 1], [0], [[0, 0]]) };
  let commands;
  const run = async given => { commands = given; return boxesThatReturn(root, index => index === 0 ? chromium : node)(given); };
  assert.equal(await quietly(() => main(['--boxes', '4'], env, root, undefined, run)), 0);
  assert.deepEqual(commands.map(({ command }) => command.split(' ')[2]), ['playwright', 'node26']);
  const unchecked = app({ ...FIXTURE, 'fuzz/a.fuzz.vibe': FIXTURE['fuzz/a.fuzz.vibe'] + 'import "../src/web/view.vibe"\n' });
  const without = async given => boxesThatReturn(unchecked, index => index === 0 ? {} : node)(given);
  assert.equal(await quietly(() => main(['--boxes', '4'], env, unchecked, undefined, without)), 1, 'Node alone leaves the statement Chromium ran');
});
