// Fuzz before landing (decision 0015, "Fuzz before landing"): the fuzz targets that reach each changed source through
// the module graph, run at their seeded floor with coverage, and the receipt the landing check reads. Plain Node, like
// landing.cjs, because land-main runs the check from a bare workspace.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const app = path.resolve(__dirname, '..');
const RECEIPT_VERSION = 1;
const METRICS = ['lines', 'branches', 'functions', 'statements'];

/** The sources the fuzz gate measures that this check covers: every `.vibe` file under src/ and worker/. */
const measured = file => /^(src|worker)\/.+\.vibe$/.test(file);

const posix = file => file.split(path.sep).join('/');

/** Every `.vibe` file under `directory` (app-relative), sorted. */
function vibeFiles(root, directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return [];
  return fs.readdirSync(absolute, { recursive: true }).map(posix).filter(name => name.endsWith('.vibe'))
    .map(name => `${directory}/${name}`).sort();
}

/**
 * The app's emitted programs (every `tsconfig*.json` with an `outDir`): a target that runs an emitted file runs the
 * source it was compiled from, and one that runs from the output directory itself can run any of its sources.
 */
function emittedPrograms(root) {
  return fs.readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name)).flatMap(name => {
    const config = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    const options = config.compilerOptions ?? {};
    if (typeof options.outDir !== 'string') return [];
    const sources = (config.include ?? []).flatMap(entry => {
      const base = entry.replace(/\/\*\*.*$/, '').replace(/\/$/, '');
      return entry.endsWith('.vibe') && !entry.includes('*') ? [base] : vibeFiles(root, base);
    });
    return [{ outDir: posix(path.normalize(options.outDir)), rootDir: posix(path.normalize(options.rootDir ?? '.')), sources }];
  });
}

/**
 * The app-relative files `file` reaches: every quoted relative specifier (static and dynamic imports, re-exports,
 * `new URL(…, import.meta.url)`, a workerd `bundle(…)`), and in HTML every root-absolute `src`. A specifier into an
 * emitted program's output reaches its source (`programs`). A specifier that names no file in the app is not an edge.
 */
function edges(root, file, text, programs = []) {
  const found = new Set();
  const add = target => {
    const clean = target.replace(/[?#].*$/, '');
    const absolute = path.resolve(root, clean);
    const relative = posix(path.relative(root, absolute));
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split('/').includes('node_modules')) return;
    const program = programs.find(candidate => relative === candidate.outDir || relative.startsWith(candidate.outDir + '/'));
    if (program !== undefined) {
      const inside = relative.slice(program.outDir.length + 1);
      const source = posix(path.join(program.rootDir, inside.replace(/\.js$/, '.vibe')));
      const reached = inside === '' ? program.sources : program.sources.filter(candidate => candidate === source);
      for (const candidate of reached) found.add(candidate);
      return;
    }
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) found.add(relative);
  };
  for (const match of text.matchAll(/["'`](\.{1,2}\/[^"'`\s$]+)["'`]/g)) add(path.join(path.dirname(file), match[1]));
  if (file.endsWith('.html')) for (const match of text.matchAll(/\ssrc="(\/[^"]+)"/g)) add(match[1].slice(1));
  return [...found];
}

/** Every app file reachable from `roots`, the roots included. */
function closure(root, roots, cache = new Map(), programs = emittedPrograms(root)) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!cache.has(file)) cache.set(file, edges(root, file, fs.readFileSync(path.join(root, file), 'utf8'), programs));
    stack.push(...cache.get(file));
  }
  return seen;
}

/**
 * The fuzz suite's targets as the flow runs them: each `fuzz/*.fuzz.vibe` file is one Vitest target, and the browser
 * phase is one more. The browser phase loads `fuzz/browser.spec.ts` and the site its web server builds from
 * `index.html` (fuzz/browser.config.ts), so both are its roots.
 */
function suite(root) {
  const files = fs.readdirSync(path.join(root, 'fuzz')).filter(name => name.endsWith('.fuzz.vibe')).sort();
  return [
    ...files.map(name => ({ name: `fuzz/${name}`, kind: 'vitest', roots: [`fuzz/${name}`] })),
    { name: 'browser', kind: 'browser', roots: ['fuzz/browser.spec.ts', 'index.html'] },
  ];
}

/** The targets whose closure holds a changed file, and every changed file no target reaches. */
function select(changed, targets) {
  const selected = targets.filter(target => changed.some(file => target.reaches.has(file)));
  const unreached = changed.filter(file => !targets.some(target => target.reaches.has(file)));
  return { selected, unreached };
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const hashes = (root, files) => Object.fromEntries(files.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));

/** The app's measured sources that `jj diff --from base --to rev` changes and the tip still has. */
function changedFiles(root = app, base = 'main@origin', rev = '@') {
  // jj prints paths relative to its working directory, so it runs at the repository root.
  const found = spawnSync('jj', ['root'], { cwd: root, encoding: 'utf8' });
  if (found.error || found.status !== 0) throw Error(`jj root failed: ${found.error?.message ?? found.stderr.trim()}`);
  const repository = found.stdout.trim();
  const run = spawnSync('jj', ['diff', '--from', base, '--to', rev, '--name-only'], { cwd: repository, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw Error(`jj diff --from ${base} --to ${rev} failed: ${run.error?.message ?? run.stderr.trim()}`);
  const prefix = posix(path.relative(fs.realpathSync(repository), fs.realpathSync(root))) + '/';
  return run.stdout.split('\n').filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length))
    .filter(file => measured(file) && fs.existsSync(path.join(root, file))).sort();
}

/**
 * Why the tip may not land, from the changed files' hashes and the receipts on disk: none when no measured source
 * changed, or one passing receipt holds every changed file with exactly its current contents.
 */
function receiptRefusals(current, receipts) {
  const files = Object.keys(current);
  if (files.length === 0) return [];
  const passing = receipts.filter(receipt => receipt.version === RECEIPT_VERSION && receipt.result === 'passed');
  if (passing.some(receipt => files.every(file => receipt.files?.[file] === current[file]))) return [];
  const known = file => passing.some(receipt => receipt.files?.[file] !== undefined);
  return [`no passing fuzz receipt for these contents: run pnpm fuzz:affected (${files.length} changed source(s))`,
    ...files.map(file => `  ${known(file) ? 'changed since its receipt' : 'never fuzzed'}: ${file}`)];
}

/** Every receipt in `directory`; an unreadable one counts as none. */
function readReceipts(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]; } catch { return []; }
  });
}

/**
 * The landing check's verdict for the working copy against `base`: `not needed` (no measured source changed),
 * `matched` or `missing`, with its refusals. Receipts live in the lane's own workspace, in an ignored directory. A jj
 * failure is one refusal line, so land-main shows the reason rather than a stack trace.
 */
function landingRefusals(root = app, base = 'main@origin') {
  let changed;
  try { changed = changedFiles(root, base); } catch (error) { return { receipt: 'missing', refused: [`fuzz receipt: jj diff failed: ${error.message}`] }; }
  if (changed.length === 0) return { receipt: 'not needed', refused: [] };
  const refused = receiptRefusals(hashes(root, changed), readReceipts(path.join(root, 'fuzz-results', 'affected')));
  return { receipt: refused.length ? 'missing' : 'matched', refused };
}

/** Each changed file's four metrics from the merged report's summary, and every one below 100% (or missing). */
function shortfalls(root, files, summary) {
  const byFile = new Map(Object.entries(summary).map(([file, value]) => [path.relative(root, file).split(path.sep).join('/'), value]));
  return files.flatMap(file => {
    const entry = byFile.get(file);
    if (entry === undefined) return [`${file}: not in the fuzz report`];
    return METRICS.filter(metric => entry[metric].pct !== 100).map(metric => `${file} ${metric}: ${entry[metric].covered}/${entry[metric].total}`);
  });
}

/** The changed files: FUZZ_AFFECTED_FILES (one per line or space) when set, as a box without jj needs, else jj's. */
function requested(root, env) {
  const named = env.FUZZ_AFFECTED_FILES;
  if (named === undefined) return changedFiles(root);
  return [...new Set(named.split(/\s+/).filter(Boolean))].filter(file => measured(file) && fs.existsSync(path.join(root, file))).sort();
}

/** `pnpm fuzz:affected`: 0 when every changed source is at 100% under the targets that reach it, else 1. */
function main(argv, env = process.env, root = app) {
  const started = Date.now();
  const changed = requested(root, env);
  // One line, so a lane can hand it to a box that has no jj: FUZZ_AFFECTED_FILES="$(pnpm -s fuzz:affected --list)".
  if (argv.includes('--list')) { process.stdout.write(changed.join(' ') + '\n'); return 0; }
  const cache = new Map();
  const programs = emittedPrograms(root);
  const targets = suite(root).map(target => ({ ...target, reaches: closure(root, target.roots, cache, programs) }));
  const { selected, unreached } = select(changed, targets);
  // Counts and app paths only: no source text.
  console.log(`fuzz:affected: ${changed.length} changed source(s), ${selected.length} of ${targets.length} target(s) reach them`);
  if (changed.length === 0) { console.log('fuzz:affected: nothing to fuzz'); return 0; }
  if (unreached.length) {
    console.error(`fuzz:affected: no fuzz target imports ${unreached.length} changed source(s); add a target in fuzz/:\n  ${unreached.join('\n  ')}`);
    return 1;
  }
  if (!selected.some(target => target.kind === 'vitest')) {
    console.error('fuzz:affected: only the browser phase reaches these sources; the report needs a Vitest target too: add one in fuzz/');
    return 1;
  }
  const before = hashes(root, changed);
  const vitest = selected.filter(target => target.kind === 'vitest').map(target => target.name);
  const browser = selected.some(target => target.kind === 'browser');
  for (const name of selected.map(target => target.name)) console.log(`  ${name}`);
  const flow = spawnSync('pnpm', ['fuzz'], {
    cwd: root, stdio: 'inherit',
    env: { ...env, FUZZ_COVERAGE: '1', FUZZ_FLOOR_ONLY: '1', FUZZ_TARGETS: vitest.join(' '), FUZZ_BROWSER: browser ? '1' : '0', FUZZ_REPORT_FILES: changed.join(' ') },
  });
  const summaryFile = path.join(root, 'coverage', 'fuzz', 'coverage-summary.json');
  const below = flow.status === 0 && fs.existsSync(summaryFile) ? shortfalls(root, changed, JSON.parse(fs.readFileSync(summaryFile, 'utf8')))
    : [flow.status === 0 ? 'no merged fuzz report' : 'the fuzz flow failed'];
  const after = hashes(root, changed);
  const moved = changed.filter(file => before[file] !== after[file]);
  const result = flow.status === 0 && below.length === 0 && moved.length === 0 ? 'passed' : 'failed';
  const receipt = {
    version: RECEIPT_VERSION, result, files: before, targets: selected.map(target => target.name), floorOnly: true,
    seed: env.FUZZ_SEED ?? '20261107', flowExit: flow.status, below, at: new Date().toISOString(), elapsedMs: Date.now() - started,
  };
  const directory = path.join(root, 'fuzz-results', 'affected');
  fs.mkdirSync(directory, { recursive: true });
  const name = path.join(directory, `${sha256(JSON.stringify(before)).slice(0, 16)}.json`);
  fs.writeFileSync(name, JSON.stringify(receipt, null, 2) + '\n');
  for (const line of below) console.error(`fuzz:affected: not passed: ${line}`);
  for (const file of moved) console.error(`fuzz:affected: changed during the run, rerun: ${file}`);
  console.log(`fuzz:affected: ${result} (flow exit ${flow.status}, ${below.length} shortfall(s), ${Date.now() - started} ms); receipt ${path.relative(root, name)}`);
  return result === 'passed' ? 0 : 1;
}

module.exports = { main, edges, closure, emittedPrograms, suite, select, sha256, hashes, changedFiles, receiptRefusals, readReceipts, landingRefusals, shortfalls, measured, RECEIPT_VERSION };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
