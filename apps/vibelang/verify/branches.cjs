// Branches in shell rows (decision 0018, "Decisions in shell rows"): an `if` or conditional inside a row that is not
// proved, outside the view markup in src/web/, with an operand (split at `&&`, `||` and `!`) that neither calls a
// proved function, nor reads a `const` whose value calls one (in its row or an enclosing row) as a flag or against a
// literal (`replay === "replay-refused"`, `cut < 0`: the proved function's answer), nor calls a function whose whole
// body returns a proved call, nor is a
// presence or variant test or a host type guard (`=== undefined`, `null`, `_tag`, `typeof`, `Option.isSome`,
// `Exit.isSuccess`, `Number.isSafeInteger` and the like; inventory.cjs `neutral`). A shell row's reason covers
// the whole row, so a new branch would inherit it unseen; the landing check refuses a branch that
// verify/shell-branches.tsv does not record with a reason. A reason starting "Open:" is a decision still to prove.
const fs = require('node:fs');
const path = require('node:path');
const app = path.resolve(__dirname, '..');
const record = path.join(__dirname, 'shell-branches.tsv');
const HEADER = '# file\tfunction\tcondition\treason (decision 0018, "Decisions in shell rows"; "Open:" = still to prove)';

const inScope = file => !file.startsWith('src/web/');
// Callback labels carry their line (`answer/callback@88`); the record does not, so moving code changes nothing.
const stable = label => label.replace(/@\d+/g, '');
const key = ({ file, label, test }) => `${file}\t${stable(label)}\t${test}`;

/** Branches in shell rows with an operand no proved function decides. */
function shellBranches(rows) {
  const proved = new Set(rows.filter(row => row.proof).map(row => row.label));
  // A top-level function whose whole body returns a proved call (`allowed` returns the proved entryAllowed) decides
  // nothing of its own: it counts as proved, to a fixpoint.
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!row.label.includes('/') && row.delegate && proved.has(row.delegate) && !proved.has(row.label)) { proved.add(row.label); grew = true; }
  }
  const callsProved = calls => calls.some(name => proved.has(name));
  const decidedFlags = row => new Set(rows.filter(other => other.file === row.file && other.bindings
    && (other.label === row.label || row.label.startsWith(other.label + '/')))
    .flatMap(other => other.bindings.filter(binding => callsProved(binding.calls)).map(binding => binding.name)));
  return rows.filter(row => row.category !== 'proved' && inScope(row.file) && row.branches).flatMap(row => {
    const flags = decidedFlags(row);
    return row.branches.filter(branch => !branch.operands.every(operand => operand.neutral || callsProved(operand.calls) || flags.has(operand.flag) || flags.has(operand.compared)))
      .map(branch => ({ file: row.file, line: branch.line, label: row.label, test: branch.test }));
  });
}

/** The record's lines as { key, reason }; comments and blank lines skipped. */
function parseRecord(text) {
  return text.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => {
    const cells = line.split('\t');
    return { key: cells.slice(0, 3).join('\t'), reason: (cells[3] ?? '').trim() };
  });
}

/** Refusals for unrecorded branches and reasonless records; `stale` lists records no branch matches. */
function branchFacts(rows, recordText) {
  const left = new Map();
  const recorded = parseRecord(recordText);
  for (const { key: k } of recorded) left.set(k, (left.get(k) ?? 0) + 1);
  const refused = [];
  const branches = shellBranches(rows);
  for (const branch of branches) {
    const k = key(branch);
    if (left.get(k)) left.set(k, left.get(k) - 1);
    else refused.push(`unrecorded branch: ${branch.file}:${branch.line} ${stable(branch.label)}: prove its decision, or add to verify/shell-branches.tsv: ${k}\t<reason>`);
  }
  for (const { key: k, reason } of recorded) if (!reason) refused.push(`branch record with no reason: ${k}`);
  const stale = [...left].flatMap(([k, n]) => Array(n).fill(k));
  const open = recorded.filter(({ key: k, reason }) => reason.startsWith('Open:') && !stale.includes(k)).length;
  return { refused, branches: branches.length, open, stale };
}

/** The record without its stale lines (`--prune`), or with every unrecorded branch added as `reason` (`--add REASON`). */
function rewritten(rows, recordText, addReason) {
  const { stale } = branchFacts(rows, recordText);
  const drop = new Map();
  for (const k of stale) drop.set(k, (drop.get(k) ?? 0) + 1);
  const kept = recordText.split('\n').filter(line => line.trim()).filter(line => {
    if (line.startsWith('#')) return false;
    const k = line.split('\t').slice(0, 3).join('\t');
    if (!drop.get(k)) return true;
    drop.set(k, drop.get(k) - 1);
    return false;
  });
  if (addReason) {
    const have = new Map();
    for (const line of kept) { const k = line.split('\t').slice(0, 3).join('\t'); have.set(k, (have.get(k) ?? 0) + 1); }
    for (const branch of shellBranches(rows)) {
      const k = key(branch);
      if (have.get(k)) have.set(k, have.get(k) - 1); else kept.push(`${k}\t${addReason}`);
    }
  }
  kept.sort((a, b) => a.localeCompare(b));
  return [HEADER, ...kept].join('\n') + '\n';
}

function main() {
  const { inventorySource, sourceFiles } = require('./inventory.cjs');
  const rows = sourceFiles().flatMap(file => inventorySource(file, fs.readFileSync(file, 'utf8')));
  const text = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';
  const at = process.argv.indexOf('--add');
  if (process.argv.includes('--prune') || at > 0) fs.writeFileSync(record, rewritten(rows, text, at > 0 ? process.argv[at + 1] : undefined));
  const facts = branchFacts(rows, fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '');
  // Counts only, and the refused branches themselves.
  console.log(`shell branches: ${facts.branches} found, ${facts.open} open, ${facts.stale.length} stale records, ${facts.refused.length} refused`);
  if (facts.refused.length) { console.error(facts.refused.join('\n')); process.exitCode = 1; }
}
module.exports = { shellBranches, branchFacts, rewritten, record };
if (require.main === module) main();
