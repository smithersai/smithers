// The landing check (decision 0018, "Landing check"): what `pnpm test` refuses before a tree reaches main, from the
// inventory and the mutation case list only, never Dafny. `pnpm verify` and `pnpm verify:broken` still prove the
// contracts and reject the mutants; this keeps a tree that no proof run has seen from claiming either.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventorySource, sourceFiles, withTable, decision } = require('./inventory.cjs');
const { branchFacts, record } = require('./branches.cjs');
const { landingRefusals } = require('./fuzz_affected.cjs');
const app = path.resolve(__dirname, '..');

/** Every reason the tree may not land. A contract needs a mutant unless it is a lemma or restates its table. */
function refusals({ rows, decisionText, cases, staleCases = [], staleRuntime = [], invalidMutants = [], branchRecord }) {
  const refused = [];
  for (const row of rows) {
    if (row.why.startsWith('Not yet proved')) refused.push(`not proved: ${row.file}:${row.line} ${row.label}`);
  }
  if (withTable(decisionText, rows) !== decisionText) refused.push('stale inventory: run node verify/inventory.cjs --write');
  const mutated = new Set(cases.map(([module, fn]) => `${module}:${fn}`));
  for (const row of rows) {
    if (row.proof !== 'contract' || row.lemma || row.why.startsWith('Specification restated')) continue;
    if (!mutated.has(`${row.file}:${row.label}`)) refused.push(`no mutant: ${row.file}:${row.line} ${row.label}`);
  }
  for (const line of staleCases) refused.push(`stale mutation: ${line}`);
  for (const line of staleRuntime) refused.push(`stale runtime mutation: ${line}`);
  refused.push(...invalidMutants);
  if (branchRecord !== undefined) refused.push(...branchFacts(rows, branchRecord).refused);
  return refused;
}

/** The mutation cases as [module, function, name], and every case that no longer matches its source exactly once. */
function mutationFacts() {
  const run = args => spawnSync('python3', [path.join(__dirname, 'mutations.py'), ...args],
    { cwd: app, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const listed = run(['--cases']);
  if (listed.error || listed.status !== 0) throw Error(`mutations.py --cases failed: ${listed.error?.message ?? listed.stderr}`);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-'));
  try {
    const checked = run([out, '--check']);
    if (checked.error) throw checked.error;
    const staleCases = checked.status === 0 ? [] : (checked.stderr.trim().split('\n').filter(line => line && line !== 'Stale mutations:'));
    // A stale case writes no mutant, so only a tree with none is typechecked.
    return { cases: JSON.parse(listed.stdout), staleCases, invalidMutants: staleCases.length ? [] : mutantTypes() };
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

/** Every runtime adapter mutation (verify/runtime_mutations.py) whose text no longer matches its source exactly once. */
function runtimeFacts() {
  const run = spawnSync('python3', [path.join(__dirname, 'runtime_mutations.py'), '--check'], { cwd: app, encoding: 'utf8' });
  if (run.error) throw run.error;
  const lines = run.stdout.split('\n').filter(Boolean);
  if (run.status !== 0 && lines.length === 0) throw Error(`runtime_mutations.py --check exited ${run.status}: ${run.stderr.slice(-4000)}`);
  return lines;
}

/** Every mutant that no longer typechecks (verify/mutant_types.py, about 45 s), one refusal line each. */
function mutantTypes() {
  const run = spawnSync('python3', [path.join(__dirname, 'mutant_types.py')], { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  const lines = run.stdout.split('\n').filter(line => line.startsWith('invalid mutant: ') || line.startsWith('typecheck failure outside any mutant: '));
  if (run.status !== 0 && lines.length === 0) throw Error(`mutant_types.py exited ${run.status}: ${(run.stderr || run.stdout).slice(-4000)}`);
  return lines;
}

/** The facts for the tree on disk. */
function treeFacts() {
  const rows = sourceFiles().flatMap(file => inventorySource(file, fs.readFileSync(file, 'utf8')));
  return { rows, decisionText: fs.readFileSync(decision, 'utf8'), branchRecord: fs.readFileSync(record, 'utf8'), staleRuntime: runtimeFacts(), ...mutationFacts() };
}

function main() {
  const started = Date.now();
  const facts = treeFacts();
  // A range that changes a src/ or worker/ source lands only with its passing `pnpm fuzz:affected` receipt (0015,
  // "Fuzz before landing"). It reads jj, so it runs here, under land-main, and never in `pnpm test`'s treeFacts.
  const fuzz = landingRefusals();
  const refused = [...refusals(facts), ...fuzz.refused];
  const contracts = facts.rows.filter(row => row.proof === 'contract').length;
  // Counts only: no source text, names or paths beyond the refused rows themselves.
  const branches = branchFacts(facts.rows, facts.branchRecord);
  console.log(`landing check: ${facts.rows.length} rows, ${contracts} contracts, ${facts.cases.length} mutation cases `
    + `(${facts.invalidMutants.length} invalid), `
    + `${branches.branches} shell branches (${branches.open} open), fuzz receipt: ${fuzz.receipt}, ${refused.length} refused, ${Date.now() - started} ms`);
  if (refused.length) { console.error(refused.join('\n')); process.exitCode = 1; }
}
module.exports = { refusals, treeFacts };
if (require.main === module) main();
