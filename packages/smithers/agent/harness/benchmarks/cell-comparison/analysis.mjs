// Pure receipt validation and statistics; no provider or platform dependencies.
const arms = ['cell', 'tool']
const outcomes = ['correct', 'wrong', 'turn_limit', 'access_failure', 'model_failure', 'cell_failure', 'tool_failure', 'harness_failure']
const measurable = r => !['access_failure', 'model_failure', 'harness_failure'].includes(r.outcome)
export function validate(manifest, rows) {
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0 || new Set(manifest.tasks).size !== manifest.tasks.length) throw new Error('invalid task roster')
  if (!Number.isSafeInteger(manifest.maxTurns) || manifest.maxTurns <= 0) throw new Error('invalid turn limit')
  const expected = new Set(manifest.tasks.flatMap(t => arms.map(a => `${t}/${a}`)))
  const seen = new Set()
  for (const r of rows) {
    const key = `${r.task}/${r.arm}`
    if (seen.has(key)) throw new Error(`duplicate receipt ${key}`)
    if (!expected.has(key)) throw new Error(`unexpected receipt ${key}`)
    seen.add(key)
    for (const name of ['taskHash', 'model', 'cohort', 'maxTurns']) {
      if (r[name] !== manifest[name]) throw new Error(`unmatched ${name}: ${key}`)
    }
    if (!outcomes.includes(r.outcome)) throw new Error(`invalid outcome ${key}`)
    if (!Number.isFinite(r.elapsedMs) || r.elapsedMs < 0) throw new Error(`invalid elapsed ${key}`)
    if (!Array.isArray(r.turns) || r.turns.length > manifest.maxTurns) throw new Error(`invalid turns ${key}`)
    for (const turn of r.turns) {
      if (turn.cost != null && (!Number.isFinite(turn.cost.costUsd) || turn.cost.costUsd < 0)) throw new Error(`invalid cost ${key}`)
    }
  }
  for (const key of expected) if (!seen.has(key)) throw new Error(`missing receipt ${key}`)
}
export function wilson(k, n) {
  const z = 1.959963984540054
  const p = k / n, d = 1 + z*z/n
  const center = (p + z*z/(2*n))/d
  const half = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
  return [Math.max(0, center-half), Math.min(1, center+half)]
}
export function analyze(manifest, rows) {
  validate(manifest, rows)
  const result = {}
  for (const arm of arms) {
    const rs = rows.filter(r => r.arm === arm)
    const turns = rs.flatMap(r => r.turns)
    const correct = rs.filter(r => r.outcome === 'correct').length
    const priced = turns.filter(t => t.cost != null)
    result[arm] = {
      attempts: rs.length, answered: rs.filter(measurable).length, correct,
      successInterval95: wilson(correct, rs.length),
      failures: Object.fromEntries(outcomes.filter(o => o !== 'correct').map(o => [o, rs.filter(r => r.outcome === o).length])),
      turns: turns.length, pricedTurns: priced.length,
      costUsd: turns.length > 0 && priced.length === turns.length ? priced.reduce((n,t) => n+t.cost.costUsd,0) : null,
      inputTokensReported: turns.reduce((n,t) => n+(t.usage?.inputTokens ?? 0),0),
      outputTokensReported: turns.reduce((n,t) => n+(t.usage?.outputTokens ?? 0),0),
      usageReportingTurns: turns.filter(t => t.usage?.inputTokens !== undefined && t.usage?.outputTokens !== undefined).length,
      elapsedMeanMs: rs.reduce((n,r) => n+r.elapsedMs,0)/rs.length
    }
  }
  const pairs = manifest.tasks.map(task => arms.map(arm => rows.find(r => r.task === task && r.arm === arm))).filter(p => p.every(measurable))
  result.completedPairs = pairs.length
  result.qualityDifference = null
  if (pairs.length > 0) {
    const differences = pairs.map(([c,t]) => Number(c.outcome === 'correct') - Number(t.outcome === 'correct'))
    const estimate = differences.reduce((a,b) => a+b,0)/pairs.length
    // Hoeffding for independent bounded paired differences in [-1,1].
    const half = Math.sqrt(2*Math.log(40)/pairs.length)
    result.qualityDifference = { estimate, low: Math.max(-1,estimate-half), high: Math.min(1,estimate+half), confidence: 0.95, method: 'paired Hoeffding bound', n: pairs.length }
  }
  return result
}
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
export function render(manifest, rows) {
  const summary = analyze(manifest, rows)
  const pct = n => `${(100*n).toFixed(1)}%`
  const difference = summary.qualityDifference
  const conclusion = difference === null ? 'No paired task-quality conclusion: access or harness failures prevented measurement.' : `Cell minus tool success on ${difference.n} measurable pairs: ${pct(difference.estimate)}; 95% bound [${pct(difference.low)}, ${pct(difference.high)}]. ${difference.low <= 0 && difference.high >= 0 ? 'The interval includes zero.' : 'The bound excludes zero under the stated independence assumption.'}`
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cell versus tool calls — #1846</title><style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:16px/1.5 system-ui;color:#18212a;background:#fafbfc}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3da;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf1f4;padding:16px}summary{cursor:pointer}h1{font-size:30px}</style><h1>Cell versus tool calls</h1><p>Issue #1846 · ${escape(manifest.createdAt)} · ${escape(manifest.model)} · cohort ${escape(manifest.cohort)}</p><p><strong>${escape(conclusion)}</strong></p><table><tr><th>Arm</th><th>Correct / attempted</th><th>Wilson 95% interval</th><th>Model turns</th><th>Input / output tokens reported</th><th>Mean wall ms</th><th>USD estimate</th></tr>${arms.map(a => {const s=summary[a];return `<tr><td>${a}</td><td>${s.correct} / ${s.attempts}</td><td>${s.successInterval95.map(pct).join(' – ')}</td><td>${s.turns}</td><td>${s.inputTokensReported} / ${s.outputTokensReported} (${s.usageReportingTurns}/${s.turns} turns metered)</td><td>${s.elapsedMeanMs.toFixed(1)}</td><td>${s.costUsd === null ? `unknown (${s.pricedTurns}/${s.turns} turns priced)` : s.costUsd.toFixed(6)}</td></tr>`}).join('')}</table><h2>Method and limits</h2><p>The immutable task corpus has 50 tasks: ten fixed seeds in each of filtering, grouping, deduplication, joins and tag normalization. Both arms receive identical task instructions and records, the same model, credential cohort, reasoning effort and six-turn ceiling. The cell arm emits JavaScript in a persistent production QuickJS realm; the tool arm uses native function calls. Both read through the same recorded records action and submit an object. The evaluator compares canonical JSON with an independently prepared answer. Expected answers never enter model requests.</p><p>Tasks run sequentially; arm order alternates by task to balance drift. Each call has one attempt, without benchmark retries. Fixture seeds fix inputs; the subscription endpoint exposes no sampling seed. There is one stochastic sample per task and arm. These small synthetic data tasks do not establish coding-agent performance, production latency, or general model superiority. Prompt formats and executable computation differ by design. Warm provider cache and shared-host load are uncontrolled. Time includes model calls and realm/tool execution but excludes runtime startup.</p><p>Access, provider and harness failures remain attempted runs; they count as end-to-end failures but are excluded from the task-quality paired difference. Exclusion can bias that conditional difference. The paired Hoeffding bound is distribution-free for independent task-pair observations, a conservative assumption that shared provider state may violate. Wilson intervals describe each arm's end-to-end success under a binomial working model. The fixed convenience corpus is not a random sample of real workloads.</p><p>Token counts are provider observations; absent counts are unknown. USD values, where available, are estimates using the SDK price-table snapshot retained in the manifest, not subscription invoices. Any unpriced turn makes the total unknown. Subscription per-call billing is not exposed. Provider failures may incur unreported usage or charges. Task hashes, requested model (an alias, not a verified immutable provider snapshot), cohort and source identities are retained below. Normalized SDK events and requests are raw receipts at the SDK boundary; HTTP headers and credential values are never captured.</p><h2>Failures and paired statistics</h2><pre>${escape(JSON.stringify(summary,null,2))}</pre><h2>Run manifest</h2><pre>${escape(JSON.stringify(manifest,null,2))}</pre><h2>Per-task outcomes</h2><table><tr><th>Task</th><th>Cell</th><th>Tool</th></tr>${manifest.tasks.map(t => `<tr><td>${escape(t)}</td>${arms.map(a => `<td>${escape(rows.find(r => r.task===t && r.arm===a).outcome)}</td>`).join('')}</tr>`).join('')}</table><details><summary>Raw receipts (complete, embedded, credential-free)</summary><pre>${escape(JSON.stringify(rows,null,2))}</pre></details></html>`
}
