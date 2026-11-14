// Fuzz before landing (decision 0015, "Fuzz before landing"): the fuzz targets that reach each changed source through
// the module graph, run at their seeded floor with coverage, and the receipt the landing check reads. Plain Node, like
// landing.cjs, because land-main runs the check from a bare workspace.
// `--boxes N` splits the run across boxes and merges their scoped reports into the same one receipt (0015, session 22).
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

/**
 * Whether any file in `files` names the output directory of the program that `tsconfig.surfaces.json` emits
 * (dist-factory): the fuzz flow's build stage compiles it only then (FUZZ_SURFACES).
 */
function needsSurfaces(root, files) {
  const config = path.join(root, 'tsconfig.surfaces.json');
  if (!fs.existsSync(config)) return false;
  const outDir = JSON.parse(fs.readFileSync(config, 'utf8').replace(/^\s*\/\/.*$/gm, '')).compilerOptions?.outDir;
  if (typeof outDir !== 'string') return false;
  const output = posix(path.normalize(outDir));
  return [...files].some(file => [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/["'`](\.{1,2}\/[^"'`\s$]+)["'`]/g)].some(match => {
    const relative = posix(path.relative(root, path.resolve(root, path.dirname(file), match[1])));
    return relative === output || relative.startsWith(output + '/');
  }));
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

/** The repository that holds `root`: the nearest directory up with pnpm-workspace.yaml, else `root` itself. */
function repositoryOf(root) {
  for (let directory = root; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) return directory;
    if (path.dirname(directory) === directory) return root;
  }
}

/** Every file under `top` (posix, relative to it) without node_modules, .git and .jj: what run-heavy --writes compares. */
function treeFiles(top) {
  const files = new Set();
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(top, relative), { withFileTypes: true })) {
      if (['node_modules', '.git', '.jj'].includes(entry.name)) continue;
      const file = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else files.add(file);
    }
  };
  walk('');
  return files;
}

/**
 * What a run leaves behind (decision 0015, "Return size"). The intermediate reports (Vitest's, workerd's and
 * Chromium's) go once the merged summary is read; a passing run keeps only that summary of the merged report, and a
 * failing one keeps the merged report (scoped to the changed sources) and Playwright's failure traces. With
 * `--results-only` (a box run) every other file the run created goes too, so `--writes` returns only the receipt, the
 * summary, new regressions under fuzz/__fuzz__ and a failure's evidence. Other files present before the run (`before`,
 * from `treeFiles(repository)`) are never touched. Returns the number of files removed.
 */
function prune(root, { passed, resultsOnly, before, repository = repositoryOf(root), shard = false }) {
  const keep = file => file.startsWith('fuzz-results/') || file.startsWith('fuzz/__fuzz__/') || (!shard && file === 'coverage/fuzz/coverage-summary.json')
    || (!passed && (file.startsWith('coverage/fuzz/') || /^fuzz\/test-results[^/]*\//.test(file)));
  const intermediate = file => /^coverage\/fuzz(?:-unit|-browser)?\//.test(file) || /^fuzz\/test-results[^/]*\//.test(file);
  const prefix = posix(path.relative(repository, root));
  const inApp = file => prefix === '' ? file : file.startsWith(prefix + '/') ? file.slice(prefix.length + 1) : undefined;
  let removed = 0;
  const directories = new Set();
  for (const file of treeFiles(repository)) {
    const local = inApp(file);
    if (local !== undefined && keep(local)) continue;
    // The reports are regenerated by every run, so an older run's go too; anything else only when this run made it.
    if (!(local !== undefined && intermediate(local)) && (!resultsOnly || before.has(file))) continue;
    fs.rmSync(path.join(repository, file), { force: true });
    removed++;
    for (let directory = path.posix.dirname(file); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
  }
  // Deepest first, and only the directories this run's removals emptied.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    const absolute = path.join(repository, directory);
    if (fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
  }
  return removed;
}

/** The fuzz flow over these targets, the browser phase, the surfaces build if they need it, and the changed sources' report; its exit status. */
function runFlow(root, env, { vitest, browser, changed, surfaces, unit = true }) {
  return spawnSync('pnpm', ['fuzz'], {
    cwd: root, stdio: 'inherit',
    env: { ...env, FUZZ_COVERAGE: '1', FUZZ_FLOOR_ONLY: '1', FUZZ_TARGETS: vitest.join(' '), FUZZ_BROWSER: browser ? '1' : '0', FUZZ_SURFACES: surfaces ? '1' : '0', FUZZ_UNIT: unit ? '1' : '0', FUZZ_REPORT_FILES: changed.join(' ') },
  }).status;
}

/** One file's four metrics as Istanbul counts them: a line is a statement start, hit if any statement there is. */
function metricsOf(json) {
  const lines = new Map();
  for (const [id, loc] of Object.entries(json.statementMap)) lines.set(loc.start.line, Math.max(lines.get(loc.start.line) ?? 0, json.s[id] ?? 0));
  const count = values => ({ total: values.length, covered: values.filter(hits => hits > 0).length });
  const result = {
    lines: count([...lines.values()]), statements: count(Object.values(json.s)), functions: count(Object.values(json.f)),
    branches: count(Object.values(json.b).flat()),
  };
  for (const metric of METRICS) result[metric].pct = result[metric].total === 0 ? 100 : Math.floor(10000 * result[metric].covered / result[metric].total) / 100;
  return result;
}

const structure = json => JSON.stringify([json.statementMap, json.fnMap, json.branchMap]);

/**
 * The shards' scoped reports as one (`--boxes`). Every shard's Node report seeds every changed source with the same
 * structure (fuzz.config.ts includes exactly those), so a shard's hits add to another's; a shard whose structure
 * differs is refused rather than matched by position. Keys are app-relative.
 */
function mergeShards(files, reports) {
  const merged = {};
  const refused = [];
  for (const file of files) {
    const present = reports.map(report => report[file]).filter(json => json !== undefined);
    if (present.length === 0) { refused.push(`${file}: not in any shard's report`); continue; }
    const json = structuredClone(present[0]);
    for (const other of present.slice(1)) {
      if (structure(other) !== structure(json)) { refused.push(`${file}: the shards' reports disagree on its structure`); break; }
      for (const id of Object.keys(json.s)) json.s[id] += other.s[id];
      for (const id of Object.keys(json.f)) json.f[id] += other.f[id];
      for (const id of Object.keys(json.b)) json.b[id] = json.b[id].map((hits, arm) => hits + other.b[id][arm]);
    }
    merged[file] = json;
  }
  return { merged, refused };
}

/** Recorded seconds per target at the floor (verify/fuzz_costs.json, `--costs`); an unrecorded target costs the median. */
function readCosts(root) {
  const file = path.join(root, 'verify', 'fuzz_costs.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).seconds : {};
}

/**
 * Each target's seconds from shard logs: Vitest's line per file (`✓ fuzz/x.fuzz.vibe (5 tests) 1234ms`) and
 * Playwright's total for the browser phase (`5 passed (4.2m)`, which includes its site build).
 */
function costsFromLogs(texts) {
  const seconds = {};
  for (const text of texts) {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    for (const match of plain.matchAll(/^ [✓×] +\S+ +(fuzz\/\S+\.fuzz\.vibe) \(\d+ tests?\)(?: \d+ failed)? (\d+)ms$/gm)) seconds[match[1]] = Math.round(Number(match[2]) / 100) / 10;
    for (const match of plain.matchAll(/^ +\d+ (?:passed|failed) \((\d+(?:\.\d+)?)(m|s)\)$/gm)) seconds.browser = Math.round(Number(match[1]) * (match[2] === 'm' ? 60 : 1));
  }
  return seconds;
}

/**
 * The selected targets in at most `boxes` shards. The browser phase is a shard of its own (it needs the Playwright
 * image and no Vitest target: the host credits its Chromium report onto the Vitest shards' sum). The Vitest targets
 * fill the other shards, about `budget` seconds each, longest first onto the least loaded shard.
 */
function plan(selected, costs, boxes, budget = 90) {
  const known = Object.values(costs).sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1] : 30;
  const cost = name => costs[name] ?? median;
  const browser = selected.some(target => target.kind === 'browser');
  const items = selected.filter(target => target.kind === 'vitest').map(target => ({ name: target.name, cost: cost(target.name) }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  const total = items.reduce((sum, item) => sum + item.cost, 0);
  const count = Math.max(1, Math.min(boxes - (browser ? 1 : 0), items.length, Math.ceil(total / budget)));
  const shards = Array.from({ length: count }, () => ({ vitest: [], browser: false, cost: 0 }));
  for (const item of items) {
    const shard = shards.reduce((least, candidate) => candidate.cost < least.cost ? candidate : least);
    shard.vitest.push(item.name);
    shard.cost += item.cost;
  }
  return [...(browser ? [{ vitest: [], browser: true, cost: cost('browser') }] : []), ...shards.filter(shard => shard.vitest.length > 0).map(shard => ({ ...shard, vitest: shard.vitest.sort() }))];
}

/** The command a box runs for one shard: the install a fresh box needs, then this script in shard mode. */
function shardCommand(root, changed, shard) {
  const repository = repositoryOf(root);
  const up = posix(path.relative(root, repository)) || '.';
  const down = posix(path.relative(repository, root)) || '.';
  const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
  // A box has 4 vCPUs to itself: 4 Vitest workers. One browser worker: with Chromium's compilation cache off
  // (fuzz/browser.config.ts) two workers made each test 50% slower and the phase no faster (0015, session 22).
  return `node verify/fuzz_affected.cjs --snapshot /tmp/fuzz-affected-before.json && cd ${up}`
    + ` && pnpm install --frozen-lockfile --filter '@smthrs/vibelang-site...' --filter '@smithers/release-workflows...' > /dev/null && cd ${down}`
    + ` && FUZZ_AFFECTED_BEFORE=/tmp/fuzz-affected-before.json FUZZ_WORKERS=4`
    + ` FUZZ_AFFECTED_FILES=${quote(changed.join(' '))} FUZZ_AFFECTED_SHARD=${quote(JSON.stringify(shard))} pnpm fuzz:affected --results-only`;
}

/** Where shard `index` of run `run` writes its result, app-relative. */
const shardFile = (run, index) => `fuzz-results/shards/${run}/${index}.json`;

/**
 * A shard's report, app-relative; empty when there is none: the report stage's scoped merge (`fuzz`), or for the browser
 * shard Chromium's report (`fuzz-browser`, seeded with only the changed sources: fuzz/browser-reporter.ts).
 */
function scopedReport(root, directory = 'fuzz') {
  const file = path.join(root, 'coverage', directory, 'coverage-final.json');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).map(([name, json]) => [posix(path.relative(root, name)), json]));
}

/** Writes the receipt for `before` and prints the verdict; returns the exit status. */
function finish(root, { before, selected, flowExit, below, moved, started, env, extra = {} }) {
  const result = flowExit === 0 && below.length === 0 && moved.length === 0 ? 'passed' : 'failed';
  const receipt = {
    version: RECEIPT_VERSION, result, files: before, targets: selected.map(target => target.name), floorOnly: true,
    seed: env.FUZZ_SEED ?? '20261107', flowExit, below, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...extra,
  };
  const directory = path.join(root, 'fuzz-results', 'affected');
  fs.mkdirSync(directory, { recursive: true });
  const name = path.join(directory, `${sha256(JSON.stringify(before)).slice(0, 16)}.json`);
  fs.writeFileSync(name, JSON.stringify(receipt, null, 2) + '\n');
  for (const line of below) console.error(`fuzz:affected: not passed: ${line}`);
  for (const file of moved) console.error(`fuzz:affected: changed during the run, rerun: ${file}`);
  console.log(`fuzz:affected: ${result} (flow exit ${flowExit}, ${below.length} shortfall(s), ${Date.now() - started} ms); receipt ${path.relative(root, name)}`);
  return result === 'passed' ? 0 : 1;
}

/** Runs each command through `bash -c`, all at once, each one's output to its log file; resolves to the exit statuses. */
function runAll(commands) {
  const { spawn } = require('node:child_process');
  return Promise.all(commands.map(({ command, log }) => new Promise(resolve => {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.openSync(log, 'w');
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', out, out] });
    child.on('error', () => { fs.closeSync(out); resolve(127); });
    child.on('close', status => { fs.closeSync(out); resolve(status ?? 1); });
  })));
}

/**
 * `--boxes N`: the selection in at most N shards, each on its own box through FUZZ_AFFECTED_BOX, a shell command
 * prefix to which the shard's command is appended as one quoted argument (`{name}` becomes the shard's name, such as
 * `fuzz-affected-1`, and `{image}` the box image it needs: `playwright` for the browser shard, else `node26`). Each box returns its shard file (`--writes`); this merges them and writes the one receipt.
 */
async function boxes(root, env, { argv = [], changed, selected, before, started, count, runner = runAll }) {
  const template = env.FUZZ_AFFECTED_BOX;
  if (!template) { console.error('fuzz:affected: --boxes needs FUZZ_AFFECTED_BOX, the command that runs one shard on a box (decision 0015)'); return 1; }
  const run = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sha256(JSON.stringify(before)).slice(0, 8)}`;
  const shards = plan(selected, readCosts(root), count).map((shard, index) => ({ run, index, ...shard }));
  for (const shard of shards) console.log(`fuzz:affected: shard ${shard.index}: ${shard.vitest.length} target(s)${shard.browser ? ' and the browser phase' : ''}, about ${Math.round(shard.cost)} s`);
  const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
  const commands = shards.map(shard => ({
    command: `${template.replace(/\{name\}/g, `fuzz-affected-${shard.index}`).replace(/\{image\}/g, shard.browser ? 'playwright' : 'node26')} ${quote(shardCommand(root, changed, { run, index: shard.index, vitest: shard.vitest, browser: shard.browser }))}`,
    log: path.join(root, 'fuzz-results', 'shards', run, `${shard.index}.log`),
  }));
  const statuses = await runner(commands);
  if (argv.includes('--costs')) {
    const file = path.join(root, 'verify', 'fuzz_costs.json');
    const logs = commands.map(({ log }) => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    const seconds = Object.fromEntries(Object.entries({ ...readCosts(root), ...costsFromLogs(logs) }).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(file, JSON.stringify({ note: 'Seconds per fuzz target at its seeded floor on a 4-vCPU box: pnpm fuzz:affected --boxes N --costs (decision 0015).', seconds }, null, 2) + '\n');
    console.log(`fuzz:affected: recorded ${Object.keys(costsFromLogs(logs)).length} target cost(s) in verify/fuzz_costs.json`);
  }
  const results = shards.map(shard => {
    const file = path.join(root, shardFile(run, shard.index));
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  });
  const failures = [];
  shards.forEach((shard, index) => {
    const result = results[index];
    console.log(`fuzz:affected: shard ${shard.index}: box exit ${statuses[index]}, flow exit ${result?.flowExit ?? 'none'}, ${result ? Math.round(result.elapsedMs / 1000) : '?'} s; log ${path.relative(root, commands[index].log)}`);
    if (result === undefined) failures.push(`shard ${shard.index} returned no result`);
    else if (result.flowExit !== 0) failures.push(`shard ${shard.index}: the fuzz flow failed`);
    else if (Object.keys(before).some(file => result.files[file] !== before[file]) || JSON.stringify(result.vitest) !== JSON.stringify(shard.vitest) || result.browser !== shard.browser) failures.push(`shard ${shard.index} ran other contents or targets`);
  });
  const ran = new Set(results.flatMap(result => result === undefined ? [] : [...result.vitest, ...(result.browser ? ['browser'] : [])]));
  for (const target of selected) if (!ran.has(target.name)) failures.push(`no shard ran ${target.name}`);
  let below = failures;
  if (failures.length === 0) {
    const unit = results.filter(result => result.vitest.length > 0);
    const { merged, refused } = mergeShards(changed, unit.map(result => result.coverage));
    // Chromium credits Node's structure by identical source start, as the report stage merges it (fuzz/coverage.vibe).
    const chromium = results.find(result => result.vitest.length === 0)?.coverage ?? {};
    if (Object.keys(chromium).length > 0) {
      const { unionEvidence } = require('../test/support/coverageUnion.ts');
      for (const file of Object.keys(merged)) if (chromium[file] !== undefined) merged[file] = unionEvidence(merged[file], chromium[file]);
    }
    const summary = Object.fromEntries(Object.entries(merged).map(([file, json]) => [path.join(root, file), metricsOf(json)]));
    fs.writeFileSync(path.join(root, 'fuzz-results', 'shards', run, 'merged.json'), JSON.stringify(merged) + '\n');
    below = [...refused, ...shortfalls(root, changed.filter(file => merged[file] !== undefined), summary)];
  }
  const after = hashes(root, changed);
  const moved = changed.filter(file => before[file] !== after[file]);
  return finish(root, { before, selected, flowExit: failures.length ? 1 : 0, below, moved, started, env, extra: { shards: shards.map(({ index, vitest, browser }, i) => ({ index, vitest, browser, boxExit: statuses[i], elapsedMs: results[i]?.elapsedMs })) } });
}

/** `pnpm fuzz:affected`: 0 when every changed source is at 100% under the targets that reach it, else 1. */
function main(argv, env = process.env, root = app, flowRunner = runFlow, runner = runAll) {
  const started = Date.now();
  // A box records its tree before its install (`--snapshot FILE`), so --results-only also drops what the install made.
  if (argv.includes('--snapshot')) {
    fs.writeFileSync(argv[argv.indexOf('--snapshot') + 1], JSON.stringify([...treeFiles(repositoryOf(root))]));
    return 0;
  }
  const changed = requested(root, env);
  // One line, so a lane can hand it to a box that has no jj: FUZZ_AFFECTED_FILES="$(pnpm -s fuzz:affected --list)".
  if (argv.includes('--list')) { process.stdout.write(changed.join(' ') + '\n'); return 0; }
  const cache = new Map();
  const programs = emittedPrograms(root);
  const targets = suite(root).map(target => ({ ...target, reaches: closure(root, target.roots, cache, programs) }));
  const shard = env.FUZZ_AFFECTED_SHARD === undefined ? undefined : JSON.parse(env.FUZZ_AFFECTED_SHARD);
  // A shard runs exactly the targets its coordinator chose; the coordinator checks the selection and the whole.
  const { selected, unreached } = shard === undefined ? select(changed, targets)
    : { selected: targets.filter(target => target.kind === 'browser' ? shard.browser : shard.vitest.includes(target.name)), unreached: [] };
  // Counts and app paths only: no source text.
  console.log(`fuzz:affected: ${changed.length} changed source(s), ${selected.length} of ${targets.length} target(s) ${shard ? `in shard ${shard.index}` : 'reach them'}`);
  if (changed.length === 0) { console.log('fuzz:affected: nothing to fuzz'); return 0; }
  if (unreached.length) {
    console.error(`fuzz:affected: no fuzz target imports ${unreached.length} changed source(s); add a target in fuzz/:\n  ${unreached.join('\n  ')}`);
    return 1;
  }
  if (!selected.some(target => target.kind === 'vitest') && shard === undefined) {
    console.error('fuzz:affected: only the browser phase reaches these sources; the report needs a Vitest target too: add one in fuzz/');
    return 1;
  }
  const before = hashes(root, changed);
  for (const name of selected.map(target => target.name)) console.log(`  ${name}`);
  const count = argv.includes('--boxes') ? Number(argv[argv.indexOf('--boxes') + 1]) : 0;
  if (count > 0 && shard === undefined) return boxes(root, env, { argv, changed, selected, before, started, count, runner });
  const vitest = selected.filter(target => target.kind === 'vitest').map(target => target.name);
  const browser = selected.some(target => target.kind === 'browser');
  const repository = repositoryOf(root);
  const existing = env.FUZZ_AFFECTED_BEFORE ? new Set(JSON.parse(fs.readFileSync(env.FUZZ_AFFECTED_BEFORE, 'utf8'))) : treeFiles(repository);
  const surfaces = selected.some(target => needsSurfaces(root, target.reaches));
  console.log(`fuzz:affected: surfaces build ${surfaces ? 'needed' : 'skipped'}`);
  // The browser shard of `--boxes` runs no Vitest target and no report stage.
  const unit = vitest.length > 0;
  const status = flowRunner(root, { ...env, ...(shard ? { FUZZ_SHARD: '1' } : {}) }, { vitest, browser, changed, surfaces, unit });
  const resultsOnly = argv.includes('--results-only');
  if (shard !== undefined) {
    const after = hashes(root, changed);
    const result = { version: RECEIPT_VERSION, run: shard.run, index: shard.index, files: before, vitest, browser, flowExit: status === 0 && changed.every(file => before[file] === after[file]) ? 0 : 1, coverage: scopedReport(root, unit ? 'fuzz' : 'fuzz-browser'), elapsedMs: Date.now() - started };
    const file = path.join(root, shardFile(shard.run, shard.index));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result) + '\n');
    // A shard keeps only its result: two shards that both returned the same summary path would conflict on --writes.
    const removed = prune(root, { passed: true, resultsOnly, before: existing, repository, shard: true });
    console.log(`fuzz:affected: shard ${shard.index} flow exit ${result.flowExit}; removed ${removed} file(s); result ${shardFile(shard.run, shard.index)}`);
    return result.flowExit;
  }
  const summaryFile = path.join(root, 'coverage', 'fuzz', 'coverage-summary.json');
  const below = status === 0 && fs.existsSync(summaryFile) ? shortfalls(root, changed, JSON.parse(fs.readFileSync(summaryFile, 'utf8')))
    : [status === 0 ? 'no merged fuzz report' : 'the fuzz flow failed'];
  const after = hashes(root, changed);
  const moved = changed.filter(file => before[file] !== after[file]);
  const passed = status === 0 && below.length === 0 && moved.length === 0;
  const removed = prune(root, { passed, resultsOnly, before: existing, repository });
  console.log(`fuzz:affected: removed ${removed} intermediate file(s)${resultsOnly ? ', results only' : ''}`);
  return finish(root, { before, selected, flowExit: status, below, moved, started, env });
}

module.exports = { main, prune, needsSurfaces, plan, costsFromLogs, mergeShards, metricsOf, shardCommand, boxes, treeFiles, repositoryOf, edges, closure, emittedPrograms, suite, select, sha256, hashes, changedFiles, receiptRefusals, readReceipts, landingRefusals, shortfalls, measured, RECEIPT_VERSION };
if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then(status => { process.exitCode = status; });
