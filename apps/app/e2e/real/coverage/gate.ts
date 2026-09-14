import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import * as ts from "typescript"
import { CRITICAL_PATHS, DOORS, REAL_HOSTS } from "./types"
import type { CoverageGap, RealE2EEvidenceFile, RealHost, RealScenarioRunEvidence } from "./types"

export interface GateFinding {
  readonly severity: "error" | "review"
  readonly code: string
  readonly file: string
  readonly line: number
  readonly message: string
}

export interface ScenarioDeclaration {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly capabilities: readonly string[]
  readonly coverage: readonly string[]
  readonly actions: readonly string[]
  readonly hosts: readonly RealHost[]
  readonly paths: readonly string[]
  readonly doors: readonly string[]
  readonly dimensions: readonly string[]
  readonly completionEvidence: readonly string[]
}

export interface GateReport {
  readonly ok: boolean
  readonly generatedAt: string
  readonly declaredActions: readonly string[]
  readonly scenarios: readonly ScenarioDeclaration[]
  readonly runs: readonly RealScenarioRunEvidence[]
  readonly gaps: readonly CoverageGap[]
  readonly findings: readonly GateFinding[]
}

const SPEC = /\.spec\.[cm]?[jt]sx?$/
const SOURCE = /\.[cm]?[jt]sx?$/
const RESERVED_DYNAMIC_ACTION = "repository-flow:*"
const COVERAGE_TOKEN = /^(?:action|host|path|door|dimension|surface|evidence):\S+$/

const sourceFile = (file: string): ts.SourceFile => ts.createSourceFile(
  file,
  readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
)

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

const strings = (node: ts.Expression | undefined): readonly string[] | undefined => {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined
  const values: string[] = []
  for (const item of node.elements) {
    if (!ts.isStringLiteralLike(item)) return undefined
    values.push(item.text)
  }
  return values
}

const objectProperty = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  const property = node.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) &&
    ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
      (ts.isStringLiteralLike(candidate.name) && candidate.name.text === name)))
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined
}

const literal = (node: ts.Expression | undefined): string | undefined =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined

export const declaredFlowNames = (flowNameFile: string): readonly string[] => {
  const source = sourceFile(flowNameFile)
  let result: readonly string[] | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "FLOW_NAMES") {
      let initializer = node.initializer
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression
      result = strings(initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!result?.length) throw new Error(`Could not read FLOW_NAMES from ${flowNameFile}`)
  return [...new Set(result)].sort()
}

const resolveImport = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(from), specifier)
  const candidates = extname(base)
    ? [base]
    : [base + ".ts", base + ".tsx", base + ".mts", base + ".cts", join(base, "index.ts"), join(base, "index.tsx")]
  return candidates.find(existsSync)
}

/** Files whose executable code can affect a real spec. Type-only imports are excluded. */
export const executableImportClosure = (specs: readonly string[], boundary: string): readonly string[] => {
  const root = resolve(boundary)
  const pending = specs.map((file) => resolve(file))
  const seen = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    const outside = relative(root, file).startsWith("..") || resolve(file) === root
    if (seen.has(file) || outside || !SOURCE.test(file)) continue
    seen.add(file)
    const source = sourceFile(file)
    const visit = (node: ts.Node): void => {
      const staticSpecifier = ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined
      const callSpecifier = ts.isCallExpression(node) &&
        ((node.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : undefined
      const imported = resolveImport(file, staticSpecifier ?? callSpecifier ?? "")
      if (imported) pending.push(imported)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...seen].sort()
}

const callPath = (node: ts.Expression): string => {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${callPath(node.expression)}.${node.name.text}`
  return ""
}

const forbiddenCalls = new Map<string, string>([
  ["test.skip", "skipped real scenario"], ["test.fixme", "disabled real scenario"],
  ["describe.skip", "skipped real scenario"], ["it.skip", "skipped real scenario"],
  ["vi.mock", "module mock"], ["jest.mock", "module mock"], ["mock.module", "module mock"]
])
const forbiddenMemberCalls = new Map<string, string>([
  ["route", "network interception"], ["unroute", "network interception"],
  ["routeFromHAR", "captured network fixture"], ["routeWebSocket", "websocket interception"]
])

const forbiddenEnv = new Set(["SMITHERS_CHAT_STUB", "SMITHERS_E2E_CAPTURED_TARGETS", "SMITHERS_OFFLINE"])
const refusal = /(?:sign in|not authorized|permission denied|unavailable|unsupported|refus(?:e|al)|could not|can't|cannot)/i

const scenarioPathFor = (source: ts.SourceFile, node: ts.Node): readonly string[] => {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isCallExpression(current) && ["test", "test.only"].includes(callPath(current.expression))) {
      const details = current.arguments[1]
      if (details && ts.isCallExpression(details) && callPath(details.expression) === "scenario" && details.arguments[1] && ts.isObjectLiteralExpression(details.arguments[1])) {
        return (strings(objectProperty(details.arguments[1], "coverage")) ?? []).filter((token) => token.startsWith("path:")).map((token) => token.slice(5))
      }
    }
    current = current.parent
  }
  return []
}

const scanFile = (file: string): readonly GateFinding[] => {
  const source = sourceFile(file)
  const findings: GateFinding[] = []
  const add = (severity: GateFinding["severity"], code: string, node: ts.Node, message: string): void => {
    findings.push({ severity, code, file, line: lineOf(source, node), message })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const path = callPath(node.expression)
      const reason = forbiddenCalls.get(path)
      if (reason) add("error", "forbidden-double", node, `${path} is ${reason}; real E2E code must use the real boundary`)
      if (ts.isPropertyAccessExpression(node.expression)) {
        const memberReason = forbiddenMemberCalls.get(node.expression.name.text)
        if (memberReason) add("error", "forbidden-double", node, `${node.expression.name.text} is ${memberReason}; aliases cannot bypass the real boundary`)
      }
      if (/^(?:expect\([^)]*\)\.)?(?:toBeTruthy|toBeDefined)$/.test(path)) {
        add("review", "ambiguous-assertion", node, `${path} is not completion evidence on its own; reviewer must verify a later state assertion`)
      }
      if (/\.(?:toContainText|toHaveText|toMatch)$/.test(path)) {
        const text = node.arguments.map((arg) => arg.getText(source)).join(" ")
        if (/\/\\s\+\/|\/\.\+\/|not\.toHaveText\(["']{2}/.test(`${path}(${text})`)) {
          add("error", "nonempty-is-not-success", node, "A nonempty-text assertion cannot establish required completion")
        }
        if (refusal.test(text)) {
          const paths = scenarioPathFor(source, node)
          add(paths.includes("success") ? "error" : "review", "refusal-is-not-success", node, paths.includes("success")
            ? "A refusal/failure message cannot satisfy a successful scenario"
            : "Refusal assertion is valid only when this error/permission scenario also proves the requested boundary behavior")
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      callPath(node.expression.expression) === "process" && node.expression.name.text === "env" && forbiddenEnv.has(node.name.text)) {
      add("error", "stub-environment", node, `${node.name.text} enables a fake/offline product seam`)
    }
    if (ts.isStringLiteralLike(node) && /(?:fake|stub|mock)[-_]?(?:api|token|credential|endpoint)/i.test(node.text)) {
      add("error", "fake-value", node, "Fake API, token, credential, or endpoint literal in executable real-suite code")
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

const parseScenario = (file: string, source: ts.SourceFile, node: ts.ObjectLiteralExpression): ScenarioDeclaration | undefined => {
  const real = objectProperty(node, "realScenario")
  if (!real || !ts.isObjectLiteralExpression(real)) return undefined
  const id = literal(objectProperty(real, "id"))
  const capabilities = strings(objectProperty(real, "capabilities"))
  const coverage = strings(objectProperty(real, "coverage"))
  if (!id || !capabilities || !coverage) return {
    id: "<invalid>", file, line: lineOf(source, real), capabilities: capabilities ?? [], coverage: coverage ?? [],
    actions: [], hosts: [], paths: [], doors: [], dimensions: [], completionEvidence: []
  }
  const values = (prefix: string): string[] => coverage.filter((token) => token.startsWith(prefix)).map((token) => token.slice(prefix.length))
  return {
    id, file, line: lineOf(source, real), capabilities, coverage,
    actions: values("action:"), hosts: values("host:") as RealHost[], paths: values("path:"),
    doors: values("door:"), dimensions: values("dimension:"), completionEvidence: values("evidence:")
  }
}

const declaration = (
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  id: string | undefined,
  capabilities: readonly string[] | undefined,
  coverage: readonly string[] | undefined
): ScenarioDeclaration => {
  const actualCoverage = coverage ?? []
  const values = (prefix: string): string[] => actualCoverage.filter((token) => token.startsWith(prefix)).map((token) => token.slice(prefix.length))
  return {
    id: id !== undefined && capabilities !== undefined && coverage !== undefined ? id : "<invalid>", file, line: lineOf(source, node), capabilities: capabilities ?? [], coverage: actualCoverage,
    actions: values("action:"), hosts: values("host:") as RealHost[], paths: values("path:"),
    doors: values("door:"), dimensions: values("dimension:"), completionEvidence: values("evidence:")
  }
}

const parseScenarioCall = (file: string, source: ts.SourceFile, node: ts.CallExpression): ScenarioDeclaration | undefined => {
  if (callPath(node.expression) !== "scenario") return undefined
  const metadata = node.arguments[1]
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return declaration(file, source, node, literal(node.arguments[0]), undefined, undefined)
  return declaration(
    file,
    source,
    node,
    literal(node.arguments[0]),
    strings(objectProperty(metadata, "capabilities")),
    strings(objectProperty(metadata, "coverage"))
  )
}

export const scenarioDeclarations = (specs: readonly string[]): readonly ScenarioDeclaration[] => {
  const scenarios: ScenarioDeclaration[] = []
  for (const file of specs) {
    const source = sourceFile(file)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const direct = parseScenarioCall(file, source, node)
        if (direct) scenarios.push(direct)
      }
      if (ts.isCallExpression(node) && callPath(node.expression) === "test.use" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const scenario = parseScenario(file, source, node.arguments[0])
        if (scenario) scenarios.push(scenario)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return scenarios
}

const missingPerTestMetadata = (specs: readonly string[]): readonly GateFinding[] => specs.flatMap((file) => {
  const source = sourceFile(file)
  const findings: GateFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ["test", "test.only"].includes(callPath(node.expression))) {
      const details = node.arguments[1]
      if (!details || !ts.isCallExpression(details) || callPath(details.expression) !== "scenario") {
        findings.push({ severity: "error", code: "missing-per-test-scenario", file, line: lineOf(source, node), message: "Every real test requires scenario(id, metadata) as its Playwright details argument" })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
})

const walkSpecs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walkSpecs(path) : SPEC.test(entry.name) ? [path] : []
})

export interface GateOptions {
  readonly realDir: string
  readonly flowNameFile: string
  readonly resultsFile?: string
  readonly now?: string
  readonly requireComplete?: boolean
  readonly expectedRevision?: string
  readonly expectedHost?: RealHost
}

export const checkRealE2E = ({ realDir, flowNameFile, resultsFile, now, requireComplete = false, expectedRevision, expectedHost }: GateOptions): GateReport => {
  const specs = walkSpecs(realDir).filter((file) => !file.includes(`${join("coverage", "fixtures")}`))
  const actions = declaredFlowNames(flowNameFile)
  const scenarios = scenarioDeclarations(specs)
  const files = executableImportClosure(specs, resolve(realDir, "../.."))
  const findings = [...files.flatMap(scanFile), ...missingPerTestMetadata(specs)]
  const ids = new Set<string>()
  for (const scenario of scenarios) {
    const add = (code: string, message: string): void => {
      findings.push({ severity: "error", code, file: scenario.file, line: scenario.line, message })
    }
    if (scenario.id === "<invalid>" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(scenario.id)) add("invalid-scenario", "realScenario requires a stable lowercase id and literal arrays")
    if (ids.has(scenario.id)) add("duplicate-scenario", `Duplicate scenario id ${scenario.id}`)
    ids.add(scenario.id)
    if (scenario.capabilities.some((capability) => capability.trim() === "")) add("missing-capability", "Capability entries must name actual bootstrap capabilities; browser-only scenarios may explicitly declare []")
    if (scenario.coverage.some((token) => !COVERAGE_TOKEN.test(token))) add("invalid-coverage-token", "Coverage tokens require a known prefix and nonempty value")
    if (!scenario.actions.length) add("missing-action", "Scenario must name at least one action token")
    if (!scenario.hosts.length || scenario.hosts.some((host) => !(REAL_HOSTS as readonly string[]).includes(host))) add("missing-host", "Scenario must name host:local, host:production, or host:native")
    if (!scenario.paths.length || scenario.paths.some((path) => !(CRITICAL_PATHS as readonly string[]).includes(path))) add("missing-path", "Scenario must name a valid critical path")
    if (!scenario.doors.length || scenario.doors.some((door) => !(DOORS as readonly string[]).includes(door))) add("missing-door", "Scenario must name the exercised door")
    if (scenario.paths.includes("keyboard") && !scenario.dimensions.includes("keyboard")) add("keyboard-dimension", "Keyboard path requires dimension:keyboard")
    if (scenario.paths.includes("success") && !scenario.completionEvidence.length) add("missing-completion-evidence", "Success requires explicit independent completion evidence")
    for (const action of scenario.actions) if (action !== RESERVED_DYNAMIC_ACTION && !actions.includes(action)) add("unknown-action", `Unknown static action ${action}`)
  }
  if (specs.length > 0 && scenarios.length === 0) findings.push({ severity: "error", code: "no-scenarios", file: realDir, line: 1, message: "Real specs exist but declare no realScenario metadata" })

  let runs: RealScenarioRunEvidence[] = []
  if (resultsFile) {
    if (!existsSync(resultsFile)) findings.push({ severity: "error", code: "missing-run-evidence", file: resultsFile, line: 1, message: "Requested executed evidence file does not exist" })
    else {
      try {
        const evidence = JSON.parse(readFileSync(resultsFile, "utf8")) as Partial<RealE2EEvidenceFile>
        if (!Array.isArray(evidence.runs) || !Array.isArray(evidence.reporterErrors) || typeof evidence.suiteStatus !== "string") {
          findings.push({ severity: "error", code: "malformed-run-evidence", file: resultsFile, line: 1, message: "Evidence requires suiteStatus, reporterErrors, and runs" })
        } else {
          runs = evidence.runs
          if (evidence.suiteStatus !== "passed") findings.push({ severity: "error", code: "suite-did-not-pass", file: resultsFile, line: 1, message: `Playwright suite status was ${evidence.suiteStatus}` })
          for (const message of evidence.reporterErrors) findings.push({ severity: "error", code: "reporter-evidence-error", file: resultsFile, line: 1, message })
          for (const run of runs) if (!run.scenarioId || !run.host || !run.status || !/^[0-9a-f]{40,64}$/.test(run.revision) || !run.startedAt || !run.finishedAt) {
            findings.push({ severity: "error", code: "malformed-run", file: resultsFile, line: 1, message: "Every run requires scenario, verified host, explicit status, exact revision, and timestamps" })
          }
          for (const run of runs) {
            if (!(REAL_HOSTS as readonly string[]).includes(run.host) || !["passed", "failed", "timedOut", "skipped", "interrupted"].includes(run.status)) findings.push({ severity: "error", code: "malformed-run", file: resultsFile, line: 1, message: `Invalid host or verdict for ${run.scenarioId}` })
            if (run.host === "production" && (!run.buildSha || !/^[0-9a-f]{40,64}$/.test(run.buildSha))) findings.push({ severity: "error", code: "missing-production-build", file: resultsFile, line: 1, message: `Production run ${run.scenarioId} requires its deployed build SHA` })
          }
          if (expectedRevision && runs.some((run) => run.revision !== expectedRevision)) findings.push({ severity: "error", code: "unexpected-revision", file: resultsFile, line: 1, message: `Evidence does not exclusively match expected revision ${expectedRevision}` })
          if (expectedHost && runs.some((run) => run.host !== expectedHost)) findings.push({ severity: "error", code: "unexpected-host", file: resultsFile, line: 1, message: `Evidence does not exclusively match expected host ${expectedHost}` })
        }
      } catch (error) {
        findings.push({ severity: "error", code: "malformed-run-evidence", file: resultsFile, line: 1, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const gaps: CoverageGap[] = []
  const coveredActions = new Set(scenarios.flatMap((scenario) => scenario.actions))
  for (const action of actions) if (!coveredActions.has(action)) gaps.push({ kind: "action", value: action })
  for (const path of CRITICAL_PATHS) if (!scenarios.some((scenario) => scenario.paths.includes(path))) gaps.push({ kind: "critical-path", value: path })
  for (const host of REAL_HOSTS) if (!scenarios.some((scenario) => scenario.hosts.includes(host))) gaps.push({ kind: "host", value: host })
  for (const door of DOORS) if (!scenarios.some((scenario) => scenario.doors.includes(door))) gaps.push({ kind: "door", value: door })
  for (const scenario of scenarios) for (const host of scenario.hosts) {
    if (!runs.some((run) => run.scenarioId === scenario.id && run.host === host && run.status === "passed" && (!expectedRevision || run.revision === expectedRevision) && (!expectedHost || run.host === expectedHost))) gaps.push({ kind: "execution", value: host, scenarioId: scenario.id })
  }
  if (requireComplete && gaps.length) findings.push({ severity: "error", code: "incomplete-coverage", file: realDir, line: 1, message: `${gaps.length} declared/action/dimension/execution gaps remain` })
  return { ok: !findings.some((finding) => finding.severity === "error"), generatedAt: now ?? new Date().toISOString(), declaredActions: actions, scenarios, runs, gaps, findings }
}

export const formatGateReport = (report: GateReport, root: string): string => {
  const errors = report.findings.filter((finding) => finding.severity === "error")
  const reviews = report.findings.filter((finding) => finding.severity === "review")
  const lines = [
    `real E2E quality gate: ${report.ok ? "PASS" : "FAIL"}`,
    `${report.declaredActions.length} static actions; ${report.scenarios.length} scenarios; ${report.runs.filter((run) => run.status === "passed").length} executed passes; ${report.gaps.length} visible gaps`,
    `${errors.length} errors; ${reviews.length} manual-review findings`
  ]
  for (const finding of report.findings) lines.push(`${finding.severity.toUpperCase()} ${finding.code} ${relative(root, finding.file)}:${finding.line} ${finding.message}`)
  return lines.join("\n")
}
