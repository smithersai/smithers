/**
 * The deterministic checks that run after a unit is transformed and before it
 * is accepted.
 *
 * These are the parts of the migration contract a machine can settle. The
 * prompt tells the agent not to recreate the JSX runtime, not to embed a
 * scheduler, not to hide an untranslatable construct behind `any`, and not to
 * touch run state. A prompt is a request; these checks are the enforcement, and
 * a failed check fails the round exactly as a failed test does.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { createHash } from "node:crypto"
import * as ts from "typescript/unstable/ast"
import * as Detect from "./Detect.ts"
import * as Fs from "./internal/Fs.ts"
import * as Ts from "./internal/Ts.ts"
import { io, type MigrateError } from "./MigrateError.ts"
import { defaultFlowsDir, type UnitPlan } from "./Units.ts"

/**
 * One check's verdict.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly findings: ReadonlyArray<{ readonly file: string; readonly line: number; readonly message: string }>
}

/**
 * What the unit looked like at its checkpoint: the text of the files it was
 * allowed to change, and a digest of every run-state path it was not.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CheckpointFiles {
  /** Project-relative path to file text at the checkpoint. */
  readonly sources: ReadonlyMap<string, string>
  /**
   * Path to sha256 at the checkpoint, for run-state paths. Project-relative,
   * except gateway state, which lives outside the project and is keyed by its
   * absolute path and read from there.
   */
  readonly digests: ReadonlyMap<string, string>
  /**
   * Every directory that holds 0.x run state: the state directories, and the
   * parent of each database file and gateway state file. Project-relative,
   * except a gateway state directory, which is absolute.
   *
   * `digests` alone cannot prove run state is untouched, because it holds only
   * the paths that existed when the checkpoint was taken. A file written into
   * one of these directories afterwards is a write to run state that no digest
   * covers, so the check walks these roots and compares the file sets both
   * ways.
   */
  readonly runStateRoots?: ReadonlyArray<string> | undefined
  /**
   * The project-relative directory carved out of the run-state roots: the 1.0
   * flows directory, which 0.x never wrote. A file appearing there is the
   * unit's output, not a write to run state (`Checkpoint.carveRoots`).
   */
  readonly carve?: string | undefined
  /**
   * The unit's own declared sources and targets.
   *
   * A run-state root is a directory, and 0.x keeps configuration and
   * workflow sources in the same directory as its run state
   * (`.smithers/smithers.config.ts` beside `.smithers/smithers.db`). A file
   * the unit was planned to rewrite or archive is the unit's, wherever it
   * sits, so it is left out of the byte-identity check. The exact run-state
   * paths are never sources: the scanner does not read them and the archive
   * refuses to move them.
   */
  readonly owned?: ReadonlyArray<string> | undefined
}

/**
 * The one constructor registry discovery accepts on a default export.
 *
 * `@smthrs/registry`'s `internal/ModuleMetadata.ts` tokenizes the module text
 * and requires the literal tokens `export default Flow . make (`. Nothing else
 * is discovered, so nothing else counts here: a description on a `Widget.make`,
 * on a bare `make`, or on a namespace alias is a description no registry ever
 * reads.
 */
const descriptorConstructor = "Flow.make"

/** The default-exported factory call, before validating its runtime contract. */
const defaultFactory = (source: ts.SourceFile): ts.CallExpression | undefined => {
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals === true) continue
    const call = statement.expression
    if (ts.isCallExpression(call) && Ts.calleeName(call) === descriptorConstructor) return call
  }
  return undefined
}

/** Discovery reads literal metadata independently of the executable contract. */
const defaultDescriptor = (source: ts.SourceFile): ts.ObjectLiteralExpression | undefined =>
  defaultFactory(source)?.arguments.find((argument) => ts.isObjectLiteralExpression(argument))

/** The initializer or method of one property of an object literal, by name. */
const property = (
  options: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | ts.MethodDeclaration | undefined => {
  for (const member of options.properties) {
    if (ts.isShorthandPropertyAssignment(member)) {
      if (ts.isIdentifier(member.name) && member.name.text === name) return member.name
      continue
    }
    if (!ts.isPropertyAssignment(member) && !ts.isMethodDeclaration(member)) continue
    if (!(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) || member.name.text !== name) continue
    return ts.isPropertyAssignment(member) ? member.initializer : member
  }
  return undefined
}

/**
 * Whether a flow module declares the description the registry reads.
 *
 * Parsed, not matched: `// description: "x"` satisfies a regular expression and
 * declares nothing, and a flow the registry will not list is a flow nobody can
 * run.
 */
const declaresDescription = (file: string, text: string): boolean => {
  const options = defaultDescriptor(Ts.parse(file, text))
  if (options === undefined) return false
  const value = property(options, "description")
  if (value === undefined) return false
  return (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text.trim() !== ""
}

/**
 * One durable flow a module declares: `export const X = <Flow>.make("<tag>", {
 * payload, success, body })`.
 *
 * The tag and the `body` are what separate a durable flow from an action:
 * `AgentAction.make("tag", { prompt })` also takes a tag, and carries no body.
 */
interface DeclaredFlow {
  readonly name: string
}

const declaredFlows = (source: ts.SourceFile): ReadonlyArray<DeclaredFlow> => {
  const flows: Array<DeclaredFlow> = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer
      if (call === undefined || !ts.isCallExpression(call)) continue
      if (!Ts.calleeName(call).endsWith("make")) continue
      const [tag, options] = call.arguments
      if (tag === undefined || !(ts.isStringLiteral(tag) || ts.isNoSubstitutionTemplateLiteral(tag))) continue
      if (options === undefined || !ts.isObjectLiteralExpression(options)) continue
      if (property(options, "body") === undefined) continue
      if (!ts.isIdentifier(declaration.name)) continue
      flows.push({ name: declaration.name.text })
    }
  }
  return flows
}

/** The `X` of an arrow function whose whole body is `X.call(...)`. */
const delegateTarget = (value: ts.Expression | ts.MethodDeclaration): string | undefined => {
  if (!ts.isArrowFunction(value) && !ts.isMethodDeclaration(value)) return undefined
  if (value.body === undefined) return undefined
  const body = ts.isBlock(value.body)
    ? value.body.statements.length === 1 && ts.isReturnStatement(value.body.statements[0]!)
      ? value.body.statements[0].expression
      : undefined
    : value.body
  if (body === undefined || !ts.isCallExpression(body)) return undefined
  const callee = body.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined
  return callee.name.text === "call" || callee.name.text === "child" ? callee.expression.text : undefined
}

/**
 * Whether the descriptor the registry admits describes the flow the engine
 * runs.
 *
 * A migrated module default-exports the flow itself, body and all, which is
 * what the tool emits and what this check wants to see: one declaration, so
 * the contract the control plane admits is the one that runs.
 *
 * Discovery reads the default export and never a named one, so the two ways a
 * module can still admit one thing and run another are both refused here. A
 * default export that names a durable flow the module declares beside it has
 * to reach it, by `body`; one that names nothing has to carry its own
 * behavior, or it cannot be called.
 */
const describesTheFlowItDeclares = (
  file: string,
  text: string
): ReadonlyArray<{ file: string; line: number; message: string }> => {
  const source = Ts.parse(file, text)
  const options = defaultDescriptor(source)
  // A module with no descriptor at all is already reported by the description
  // check; saying it twice would only hide which contract it broke.
  if (options === undefined) return []
  const line = Fs.positionAt(text, options.getStart(source)).line
  const call = defaultFactory(source)!
  const [tag, descriptor] = call.arguments
  if (
    call.arguments.length !== 2 || tag === undefined ||
    !(ts.isStringLiteral(tag) || ts.isNoSubstitutionTemplateLiteral(tag)) ||
    tag.text.trim() === "" || descriptor !== options
  ) {
    return [{
      file,
      line,
      message: "the executable flow requires Flow.make(\"<tag>\", { ... body }) with a nonempty literal tag"
    }]
  }
  const body = property(options, "body")
  // Do not execute generated code here. Refuse absent and visibly non-callable
  // bodies; the project's typecheck and tests validate references and calls.
  const callable = body !== undefined && (
    ts.isArrowFunction(body) || ts.isFunctionExpression(body) || ts.isMethodDeclaration(body) ||
    ts.isCallExpression(body) || ts.isPropertyAccessExpression(body) ||
    (ts.isIdentifier(body) && body.text !== "undefined")
  )
  if (!callable) {
    return [{
      file,
      line,
      message: "the default flow requires a callable `body`; model or flows cannot replace it"
    }]
  }
  const payload = property(options, "payload")
  if (
    payload === undefined || !(ts.isObjectLiteralExpression(payload) || ts.isCallExpression(payload) ||
      ts.isPropertyAccessExpression(payload) || (ts.isIdentifier(payload) && payload.text !== "undefined"))
  ) {
    return [{
      file,
      line,
      message: "the default flow requires a `payload` schema or field object, including {} for no input"
    }]
  }
  const flows = declaredFlows(source)
  if (flows.length === 0) return []
  const target = delegateTarget(body)
  return target !== undefined && flows.some((flow) => flow.name === target) ? [] : [{
    file,
    line,
    message: `the default descriptor's body does not call ${
      flows.map((flow) => flow.name).join(" or ")
    }, the flow this module declares`
  }]
}

/**
 * A `TODO(migrate-smithers-v1)` marker is only allowed when the report names
 * the construct. This is what the checks compare against.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ReportedEntry {
  readonly construct: string
  readonly file: string
}

/**
 * The marker the migration leaves where a construct has no translation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const marker = "TODO(migrate-smithers-v1)"

/**
 * Only comments can carry compiler directives or migration markers. Mask
 * literal tokens before scanning trivia so examples, regular expressions,
 * JSX text and template tails cannot become comments. Interpolations remain
 * code because their expressions are separate nodes in the syntax tree.
 */
const inspectSource = (file: string, text: string) => {
  const source = Ts.parse(file, text)
  const code = text.split("")
  Ts.forEachNode(source, (node) => {
    if (
      !ts.isStringLiteral(node) && !ts.isTemplateLiteralLikeNode(node) &&
      !ts.isRegularExpressionLiteral(node) && !ts.isJsxText(node)
    ) return
    for (let index = node.getStart(source); index < node.end; index++) {
      if (code[index] !== "\n" && code[index] !== "\r") code[index] = " "
    }
  })
  const comments = text.replace(/[^\r\n]/g, " ").split("")
  const scanner = ts.createScanner(false, source.languageVariant, code.join(""))
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue
    for (let index = scanner.getTokenStart(); index < scanner.getTokenEnd(); index++) comments[index] = text[index]!
  }
  return { source, comments: comments.join(""), directives: scanner.getCommentDirectives() ?? [] }
}

type InspectedSource = ReturnType<typeof inspectSource>
type Finding = CheckResult["findings"][number]

const findNodes = (
  file: string,
  source: ts.SourceFile,
  message: (node: ts.Node) => string | undefined
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  Ts.forEachNode(source, (node) => {
    const found = message(node)
    if (found !== undefined) findings.push({ file, line: Ts.positionOf(source, node).line, message: found })
  })
  return findings
}

const unparenthesized = (expression: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expression) ? unparenthesized(expression.expression) : expression

/** Count real assertions and compiler directives separately for each kind. */
const escapeHatches = (file: string, inspected: InspectedSource): ReadonlyMap<string, ReadonlyArray<Finding>> => {
  const { source, directives } = inspected
  return new Map([
    [
      "as any",
      findNodes(file, source, (node) =>
        ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword
          ? "as any hides a construct instead of reporting it"
          : undefined)
    ],
    [
      "as unknown as",
      findNodes(file, source, (node) => {
        if (!ts.isAsExpression(node)) return undefined
        const inner = unparenthesized(node.expression)
        return ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword
          ? "as unknown as hides a construct instead of reporting it"
          : undefined
      })
    ],
    ...(["@ts-ignore", "@ts-expect-error"] as const).map((kind) =>
      [
        kind,
        directives.filter((directive) =>
          directive.type ===
            (kind === "@ts-ignore" ? ts.CommentDirectiveType.Ignore : ts.CommentDirectiveType.ExpectError)
        ).map((directive) => ({
          file,
          line: Fs.positionAt(source.text, directive.range.pos).line,
          message: `${kind} hides a construct instead of reporting it`
        }))
      ] as const
    )
  ])
}

const schedulerLoop = (node: ts.Node): string | undefined => {
  if (ts.isCallExpression(node)) {
    const callee = unparenthesized(node.expression)
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined
    if (name === "setInterval") return `${callee.getText()}( is a run loop; the engine owns scheduling`
  }
  if (ts.isWhileStatement(node)) {
    const condition = unparenthesized(node.expression)
    if (condition.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(condition) && condition.text === "1")) {
      return `while (${condition.getText()}) is a run loop; the engine owns scheduling`
    }
  }
  return undefined
}

const jsxPragma = /@jsx(?:ImportSource|Runtime)\b/g

const findAll = (
  file: string,
  text: string,
  pattern: RegExp,
  message: (match: string) => string
): ReadonlyArray<{ file: string; line: number; message: string }> => {
  const regexp = new RegExp(pattern.source, pattern.flags)
  const findings: Array<{ file: string; line: number; message: string }> = []
  let match = regexp.exec(text)
  while (match !== null) {
    findings.push({ file, line: Fs.positionAt(text, match.index).line, message: message(match[0]) })
    match = regexp.exec(text)
  }
  return findings
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Runs every deterministic check for one unit.
 *
 * `changedFiles` is what the unit says it changed; `checkpointFiles` is what
 * those files looked like before it did. Checks that ask whether something was
 * *introduced* compare the two, so a project that already had an `as any` in a
 * file the unit touched does not fail a migration that did not add one. The
 * checkpoint text is also what a seat literal is checked against, so pass the
 * unit's old sources even when no check needs a before-and-after count.
 *
 * `decisions` is the text of the operator decisions this unit recorded. A seat
 * an operator chose is allowed; a seat nobody chose and no source named is not.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const run = (
  root: string,
  unit: UnitPlan,
  changedFiles: ReadonlyArray<string>,
  checkpointFiles: CheckpointFiles,
  reported: ReadonlyArray<ReportedEntry> = [],
  decisions: ReadonlyArray<string> = []
): Effect.Effect<ReadonlyArray<CheckResult>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const absolute = (file: string): string => path.join(root, ...file.split("/"))
    const flowsDir = unit.verification.discovery.flowsDir
    const specifierContext = unit.specifiers

    const texts = new Map<string, string>()
    for (const file of changedFiles) {
      const text = yield* Fs.readOption(absolute(file))
      if (text !== undefined) texts.set(file, text)
    }

    const inFlows = (file: string): boolean => file === flowsDir || file.startsWith(`${flowsDir}/`)
    const isSource = /\.(ts|tsx|js|jsx|mjs|mts|cjs|cts)$/
    const sources = new Map(
      [...texts].filter(([file]) => isSource.test(file)).map(([file, text]) => [file, inspectSource(file, text)])
    )

    const results: Array<CheckResult> = []
    const check = (
      name: string,
      findings: ReadonlyArray<{ file: string; line: number; message: string }>
    ): void => {
      results.push({ name, ok: findings.length === 0, findings })
    }

    check(
      "no old import remains",
      [...sources].flatMap(([file, { source }]) => {
        return Ts.moduleSpecifiers(source)
          .filter((record) => Detect.isOldSpecifier(record.specifier, specifierContext))
          .map((record) => ({
            file,
            line: record.line,
            message: `${record.form} "${record.specifier}" still reaches the 0.x facade`
          }))
      })
    )

    check(
      "no JSX pragma remains",
      [...sources].flatMap(([file, { comments }]) =>
        findAll(file, comments, jsxPragma, (match) => `${match} has no JSX runtime to point at`)
      )
    )

    check(
      "no react import under the flows directory",
      [...sources].flatMap(([file, { source }]) =>
        inFlows(file)
          ? Ts.moduleSpecifiers(source).filter((record) => /^(?:react|react-dom)(?:\/|$)/.test(record.specifier)).map(
            (record) => ({
              file,
              line: record.line,
              message: `${record.form} "${record.specifier}" does not belong in a flow`
            })
          )
          : []
      )
    )

    check(
      "no escape hatch introduced",
      [...sources].flatMap(([file, inspected]) => {
        const before = escapeHatches(file, inspectSource(file, checkpointFiles.sources.get(file) ?? ""))
        // Per kind, so swapping one hatch for another is caught. Examples in
        // old prompts do not grant an allowance for new executable hatches.
        return [...escapeHatches(file, inspected)].flatMap(([kind, found]) => found.slice(before.get(kind)!.length))
          .sort((left, right) => left.line - right.line)
      })
    )

    check(
      "no scheduler loop under the flows directory",
      [...sources].flatMap(([file, { source }]) => inFlows(file) ? findNodes(file, source, schedulerLoop) : [])
    )

    check(
      "no direct database access under the flows directory",
      [...sources].flatMap(([file, { source }]) => {
        if (!inFlows(file)) return []
        const imports = Ts.moduleSpecifiers(source).filter((record) =>
          record.specifier === "bun:sqlite" || record.specifier === "node:sqlite"
        ).map((record) => ({
          file,
          line: record.line,
          message: `${record.form} "${record.specifier}" opens storage the host owns`
        }))
        return [
          ...imports,
          ...findNodes(
            file,
            source,
            (node) =>
              ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Database"
                ? "new Database( opens storage the host owns"
                : undefined
          )
        ].sort((left, right) => left.line - right.line)
      })
    )

    // Amendment 4 and 5: there is no default seat. Every seat a migrated file
    // names has to come from the model the old source named, or from a
    // decision the operator answered. A seat that comes from neither is an
    // invented model id, which is the one thing a migration must never ship.
    const sourceText = [...checkpointFiles.sources.values()].join("\n")
    check(
      "every seat comes from the source or from a decision",
      [...sources].flatMap(([file, { source }]) =>
        findNodes(file, source, (node) => {
          if (
            !ts.isPropertyAssignment(node) ||
            !(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) || node.name.text !== "seat" ||
            !(ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
          ) return undefined
          const seat = node.initializer.text
          const model = seat.includes(":") ? seat.slice(seat.indexOf(":") + 1) : seat
          // The model has to appear as a string the old source wrote, not as a
          // substring of prose: a seat `openai:gpt` is not justified by the
          // word "gpt" in a comment or a prompt sentence.
          const quoted = [`"${model}"`, `'${model}'`, `\`${model}\``, `("${model}")`, `('${model}')`]
          const justified = quoted.some((token) => sourceText.includes(token)) ||
            decisions.some((answer) => answer.includes(seat))
          return justified
            ? undefined
            : `seat "${seat}" names a model that is in neither the unit's source nor a recorded decision`
        })
      )
    )

    const flowModules = changedFiles.filter((file) => inFlows(file) && file.endsWith("/flow.ts"))
    check(
      "every flow module declares a description",
      flowModules.flatMap((file) => {
        const text = texts.get(file) ?? ""
        return declaresDescription(file, text)
          ? []
          : [{
            file,
            line: 1,
            message:
              "the registry needs `export default Flow.make(\"<tag>\", { description: \"...\" })` with a string literal to discover this flow"
          }]
      })
    )

    check(
      "every flow module's descriptor describes the flow it declares",
      flowModules.flatMap((file) => describesTheFlowItDeclares(file, texts.get(file) ?? ""))
    )

    const reportedFiles = new Set(reported.map((entry) => `${entry.file}::${entry.construct}`))
    check(
      "every TODO marker is reported",
      [...texts].flatMap(([file, text]) =>
        findAll(
          file,
          sources.get(file)?.comments ?? text,
          new RegExp(`${marker.replace(/[()]/g, "\\$&")}:?\\s*([^\\n]*)`, "g"),
          (match) => match
        )
          .flatMap((finding) => {
            const construct = finding.message.slice(marker.length).replace(/^:\s*/, "").trim()
            return reportedFiles.has(`${file}::${construct}`)
              ? []
              : [{
                ...finding,
                message: `${marker} for "${construct}" has no unresolved or unsupported report entry`
              }]
          })
      )
    )

    results.push(yield* runState(root, checkpointFiles))

    return results
  })

/**
 * Whether every 0.x run-state path holds exactly the bytes the checkpoint
 * recorded, and no run-state root has gained a file since.
 *
 * On its own because it is asked twice: once with the other checks, before
 * the archive, and once more over the final tree, after the archive and the
 * final verification have run their own commands.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const runState = (
  root: string,
  checkpointFiles: CheckpointFiles
): Effect.Effect<CheckResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Gateway state is recorded absolute, because it lives outside the
    // project. It is read where it is; anything else joins under the root.
    const absolute = (file: string): string => path.isAbsolute(file) ? file : path.join(root, ...file.split("/"))
    const owned = new Set(checkpointFiles.owned ?? [])
    const findings: Array<{ file: string; line: number; message: string }> = []
    for (const [file, expected] of checkpointFiles.digests) {
      if (owned.has(file)) continue
      const target = absolute(file)
      // A link was digested by what it names (see Checkpoint.digest), so it is
      // compared the same way and never read through.
      const link = yield* Fs.linkTarget(target)
      if (link === undefined && !(yield* Fs.exists(target))) {
        findings.push({ file, line: 1, message: "run state was removed; the tool must never touch it" })
        continue
      }
      const bytes = link !== undefined
        ? Fs.linkRecord(link)
        : yield* fs.readFile(target).pipe(Effect.mapError(io(`could not read "${file}"`)))
      if (digest(bytes) !== expected) {
        findings.push({ file, line: 1, message: "run state changed; the tool must never write to it" })
      }
    }
    // The other direction: a file that appears under a run-state root after the
    // checkpoint is a write the checkpoint's digest map cannot see, because
    // that map holds only the paths that existed when it was taken.
    for (const runStateRoot of checkpointFiles.runStateRoots ?? []) {
      for (const file of yield* Fs.walkAll(absolute(runStateRoot))) {
        const relative = `${runStateRoot}/${file}`
        // The flows directory is carved out of the run-state roots it sits in.
        const carved = checkpointFiles.carve !== undefined &&
          (relative === checkpointFiles.carve || relative.startsWith(`${checkpointFiles.carve}/`))
        if (checkpointFiles.digests.has(relative) || owned.has(relative) || carved) continue
        findings.push({
          file: relative,
          line: 1,
          message: "run state was added; the tool must never write to it"
        })
      }
    }
    return {
      name: "run state is byte-identical",
      ok: findings.length === 0,
      findings: findings.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    }
  })

/**
 * Scans the project's flows directory with the registry and fails the check on
 * any warning.
 *
 * Discovery is the last word on whether a migrated flow is real: it is the same
 * scan the CLI runs, so a flow that discovery will not list is a flow nobody
 * can run.
 *
 * `@smthrs/registry` is an optional dependency loaded here, not at module load.
 * `scan` and `plan` never call this function, so reading a project costs
 * Effect, the platform layer, and TypeScript, and nothing from the 1.0 runtime.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const discovery = (
  root: string,
  flowsDir = defaultFlowsDir
): Effect.Effect<CheckResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = path.join(root, ...flowsDir.split("/"))
    if (!(yield* Fs.isDirectory(target))) {
      return {
        name: "registry discovery",
        ok: false,
        findings: [{ file: flowsDir, line: 1, message: "the flows directory does not exist" }]
      }
    }
    const Discovery = yield* Effect.tryPromise({
      try: () => import("@smthrs/registry/Discovery"),
      catch: io("could not load @smthrs/registry; install it to run the discovery check")
    })
    const scan = yield* Discovery.make(fs, path)
      .scan({ source: "project", root: target, naming: "path" })
      .pipe(Effect.mapError((cause) => io(`could not discover flows under "${flowsDir}"`)(cause)))
    return {
      name: "registry discovery",
      ok: scan.warnings.length === 0,
      findings: scan.warnings.map((warning) => ({
        file: path.relative(root, warning.path).split(path.sep).join("/"),
        line: 1,
        message: `${warning.code}: ${warning.message}`
      }))
    }
  })

/**
 * Reports whether every check passed.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const ok = (results: ReadonlyArray<CheckResult>): boolean => results.every((result) => result.ok)
