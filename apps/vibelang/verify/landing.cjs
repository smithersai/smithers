// The landing check (decision 0018, "Landing check"): what `pnpm test` refuses before a tree reaches main, from the
// inventory and the mutation case list only, never Dafny. `pnpm verify` and `pnpm verify:broken` still prove the
// contracts and reject the mutants; this keeps a tree that no proof run has seen from claiming either.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inventorySource, sourceFiles, withTable, decision } = require('./inventory.cjs');
const app = path.resolve(__dirname, '..');

/** Every reason the tree may not land. A contract needs a mutant unless it is a lemma or restates its table. */
function refusals({ rows, decisionText, cases, staleCases = [] }) {
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
    return { cases: JSON.parse(listed.stdout), staleCases };
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

/** The facts for the tree on disk. */
function treeFacts() {
  const rows = sourceFiles().flatMap(file => inventorySource(file, fs.readFileSync(file, 'utf8')));
  return { rows, decisionText: fs.readFileSync(decision, 'utf8'), ...mutationFacts() };
}

function main() {
  const started = Date.now();
  const facts = treeFacts();
  const refused = refusals(facts);
  const contracts = facts.rows.filter(row => row.proof === 'contract').length;
  // Counts only: no source text, names or paths beyond the refused rows themselves.
  console.log(`landing check: ${facts.rows.length} rows, ${contracts} contracts, ${facts.cases.length} mutation cases, `
    + `${refused.length} refused, ${Date.now() - started} ms`);
  if (refused.length) { console.error(refused.join('\n')); process.exitCode = 1; }
}
module.exports = { refusals, treeFacts };
if (require.main === module) main();
