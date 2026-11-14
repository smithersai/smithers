// `pnpm fuzz:affected` and the landing check's receipt rule (decision 0015, "Fuzz before landing").
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { main, closure, emittedPrograms, suite, select, hashes, changedFiles, receiptRefusals, readReceipts, shortfalls, RECEIPT_VERSION } = require('./fuzz_affected.cjs');

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
