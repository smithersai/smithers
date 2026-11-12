/**
 * No shipped Node composition installs an HTTP client that ignores the egress
 * proxy its environment names.
 *
 * `@effect/platform-node` ships `NodeHttpClient.layerUndici`, whose dispatcher
 * is a bare Undici `Agent`, and a dozen siblings that build the same kind of
 * pool (`layerUndiciOptions`, `layerDispatcher`, `makeDispatcherOptions`) or a
 * bare `http.Agent` (`layerNodeHttp`, `makeAgent`). A bare agent dials every
 * origin directly: it does not read `HTTP_PROXY`, `HTTPS_PROXY` or `NO_PROXY`.
 * Provided under a layer
 * that takes `HttpClient` from context — a judge, a model transport, a fetch
 * rule, a host bundle — it also *shadows* whatever proxy-aware client the host
 * built, and the call site reads as correct either way. That is the whole
 * defect: invisible on a developer machine with open egress, fatal inside a
 * microsandbox whose only way out is a proxy, where the request leaves for the
 * origin, the firewall drops it, and the symptom surfaces as
 * `completion_unjudged` far from the composition that chose the client.
 *
 * The replacement is one constructor,
 * `@smthrs/platform-node/EgressHttpClient`'s `layer(environment)`, which routes
 * through the proxy the environment names and is exactly the plain Undici pool
 * when it names none — so an unproxied host is unchanged and there is no reason
 * for a composition to reach past it.
 *
 * So the ban is by module, not by name: outside the replacement, shipped source
 * may name only the `NodeHttpClient` exports that take their dispatcher from
 * context or configure it ({@link permitted}).
 *
 * Scope is shipped source. Test trees are deliberately outside: a test that
 * names `layerUndici` is pinning a transport it owns end to end, against a
 * loopback server, with no proxy in the picture, and it is exactly where a
 * direct pool should be spelled out. `@effect/platform-node` itself, under
 * `node_modules`, is not read.
 *
 * Run it with `node --test packages/repo-targets/contracts/egress-http-client.test.mjs`.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, it } from "node:test"
import ts from "typescript"

import { repoRoot as root } from "../scripts/workspace-packages.mjs"

/** The trees that hold shipped source. `scripts/` is absent on purpose: this file names the banned spelling. */
const scanned = ["packages", "apps", ".smithers/flows"]

/**
 * Directory names that hold no shipped source wherever they appear, or hold a
 * copy of somebody else's.
 *
 * `build` is deliberately absent. Pruning that name at any depth would drop
 * `packages/smithers/build/` — @smthrs/build-cli, @smthrs/infra and
 * @smthrs/targets, three shipped packages holding one of the very sites this
 * gate exists for, `FetchExecutor.ts`. Generated `build/` output is named by
 * path in {@link skippedPaths} instead.
 */
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  "e2e",
  "fixtures",
  "__fixtures__",
  ".git",
  ".jj",
  ".astro",
  ".cache",
  ".turbo",
  ".vite"
])

/** Generated trees, pruned by repository-relative path so no shipped package sharing a name goes with them. */
const skippedPaths = new Set([])

/** Every JavaScript, TypeScript and VibeLang extension Node, Bun or a bundler loads as code. */
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx|vibe)$/

/** Source files, never a test double and never a declaration. */
export const isSource = (name) =>
  sourceExtension.test(name)
  && !/\.d\.[cm]?ts$/.test(name)
  && !/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx|vibe)$/.test(name)

/** Every shipped source file under {@link scanned}, as repository-relative paths. */
export const sources = (repositoryRoot = root) => {
  const found = []
  // Real paths of the directories already walked, so a symlink loop ends.
  const visited = new Set()
  const walk = (directory) => {
    let entries
    try {
      const real = realpathSync(directory)
      if (visited.has(real)) return
      visited.add(real)
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = relative(repositoryRoot, join(directory, entry.name)).split(sep).join("/")
      // Git tracks symlinks and every compiler and bundler follows them, so a
      // link is judged by what it points at; the skip lists still match its name.
      let kind = entry
      if (entry.isSymbolicLink()) {
        try {
          kind = statSync(join(directory, entry.name))
        } catch {
          continue
        }
      }
      if (kind.isDirectory()) {
        if (!skippedDirectories.has(entry.name) && !skippedPaths.has(path)) walk(join(directory, entry.name))
      } else if (kind.isFile() && isSource(entry.name)) {
        found.push(path)
      }
    }
  }
  for (const tree of scanned) walk(join(repositoryRoot, tree))
  return found.sort()
}

/**
 * The bare, proxy-blind spellings.
 *
 * `\b` after the name is what keeps `layerUndiciNoDispatcher` out of the ban:
 * that one takes its dispatcher from context, which is how the replacement is
 * built in the first place.
 */
const banned = [
  { pattern: /\blayerUndici\b/, name: "NodeHttpClient.layerUndici" },
  { pattern: /\bmakeDispatcher\b/, name: "NodeHttpClient.makeDispatcher" }
]

/**
 * The `NodeHttpClient` exports shipped source may name. `layerUndiciNoDispatcher`
 * and `makeUndici` take their `Dispatcher` from context, which is how the
 * replacement routes them through the proxy; `UndiciOptions` configures them.
 * Every other export builds its own Undici `Agent` or `http.Agent`, reads the
 * process-global dispatcher, or goes through `fetch`, and none of those read
 * the environment's proxy.
 */
const permitted = new Set(["layerUndiciNoDispatcher", "makeUndici", "UndiciOptions", "Dispatcher"])

/** The module specifier of the `NodeHttpClient` module itself. */
const clientModule = /^@effect\/platform-node\/NodeHttpClient(?:\.js)?$/

/** The package root, whose `NodeHttpClient` member is the same module. */
const platformModule = /^@effect\/platform-node(?:\/index(?:\.js)?)?$/

/** The name of a member an object literal, class or interface defines: a declaration, not a read. */
const declaresMember = (node) =>
  (ts.isPropertyAssignment(node.parent)
    || ts.isMethodDeclaration(node.parent)
    || ts.isPropertyDeclaration(node.parent)
    || ts.isPropertySignature(node.parent)
    || ts.isMethodSignature(node.parent)
    || ts.isGetAccessorDeclaration(node.parent)
    || ts.isSetAccessorDeclaration(node.parent))
  && node.parent.name === node

/** A string whose whole text is the name: a property key held in a variable. */
const exact = (pattern) => new RegExp(`^${pattern.source.replaceAll("\\b", "")}$`)

const scriptKind = (path) =>
  /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS

/**
 * Every banned spelling in `content` outside a comment, as `line name` pairs.
 *
 * Two readings, both by the TypeScript parser, so a comment is never read.
 *
 * By module: a namespace bound to `NodeHttpClient` (`import * as N from
 * "@effect/platform-node/NodeHttpClient"`, `import { NodeHttpClient as N }`
 * from the package root or from a host package that re-exports it, or
 * `P.NodeHttpClient` off `import * as P from "@effect/platform-node"`) may be
 * read only for a {@link permitted} export: by member, string key, qualified
 * type name or destructuring. A named import or re-export of any other export
 * fails, and so do the forms whose name the gate cannot see: a computed key, an
 * alias of the namespace, `export *`, and a dynamic `import()` or `require` of
 * the module. Re-exporting the namespace under its own name passes, because
 * every importer of that name is read the same way.
 *
 * By name, for the two spellings that predate this gate: an identifier or a
 * computed member name is checked, so `NodeHttpClient["layerUndici"]` fails
 * too, and so does any string whose whole text is a banned name, the key of
 * `NodeHttpClient[k]`. A string that only describes the ban, such as a
 * security-review prompt, is prose like a comment. The raw-text pre-check also
 * passes any file holding a `\u` escape, so an escaped identifier reaches the
 * parser.
 *
 * A name that declares a member is not a use: Effect's `Scheduler` interface
 * has its own `makeDispatcher`, and an object literal, class or interface that
 * defines it reads nothing from `@effect/platform-node`. Reading the name,
 * destructuring it or passing it on still fails.
 *
 * Known limit: the check reads single literals, not constant folding, so a key
 * assembled at runtime and read off something that is not a known namespace,
 * such as a function parameter, passes. Review catches that spelling; this
 * gate does not.
 */
export const bannedUses = (path, content) => {
  if (!/layerUndici|makeDispatcher|NodeHttpClient|platform-node|\\u/.test(content)) return []
  const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path))
  const found = new Set()
  const report = (node, name) => found.add(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} ${name}`)
  const exported = (name) => {
    if (!permitted.has(name)) return `NodeHttpClient.${name}`
  }

  // Local names bound to the NodeHttpClient namespace, and to the package root.
  const namespaces = new Set()
  const roots = new Set()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
    if (from === undefined) continue
    const ofClient = clientModule.test(from)
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (ofClient) namespaces.add(bindings.name.text)
        else if (platformModule.test(from)) roots.add(bindings.name.text)
      } else if (bindings) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text
          if (ofClient) {
            const banned = exported(imported)
            if (banned) report(element, banned)
          } else if (imported === "NodeHttpClient") {
            namespaces.add(element.name.text)
          }
        }
      }
    } else if (ofClient) {
      const clause = statement.exportClause
      if (clause === undefined) report(statement, "NodeHttpClient.*")
      else if (ts.isNamespaceExport(clause)) {
        if (clause.name.text !== "NodeHttpClient") report(statement, `NodeHttpClient as ${clause.name.text}`)
      } else {
        for (const element of clause.elements) {
          const banned = exported((element.propertyName ?? element.name).text)
          if (banned) report(element, banned)
        }
      }
    }
  }

  /** Whether `node` evaluates to the NodeHttpClient namespace. */
  const isNamespace = (node) =>
    (ts.isIdentifier(node) && namespaces.has(node.text))
    || ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ts.isIdentifier(node.expression) && roots.has(node.expression.text)
      && (ts.isPropertyAccessExpression(node)
        ? node.name.text === "NodeHttpClient"
        : ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "NodeHttpClient"))

  /** Whether an identifier is a binding's own declaration or a member name rather than a read of the binding. */
  const notARead = (node) =>
    ts.isImportSpecifier(node.parent)
    || ts.isNamespaceImport(node.parent)
    || ts.isImportClause(node.parent)
    || declaresMember(node)
    || (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    || (ts.isQualifiedName(node.parent) && node.parent.right === node)
    || (ts.isBindingElement(node.parent) && node.parent.propertyName === node)

  /** Checks one read of the namespace by what its parent does with it. */
  const namespaceRead = (node) => {
    const parent = node.parent
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      const banned = exported(parent.name.text)
      if (banned) report(parent, banned)
    } else if (ts.isQualifiedName(parent) && parent.left === node) {
      const banned = exported(parent.right.text)
      if (banned) report(parent, banned)
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const key = parent.argumentExpression
      if (ts.isStringLiteralLike(key)) {
        const banned = exported(key.text)
        if (banned) report(parent, banned)
      } else {
        report(parent, "NodeHttpClient[computed]")
      }
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
      for (const element of parent.name.elements) {
        const key = element.propertyName ?? element.name
        const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined
        const banned = name === undefined ? "NodeHttpClient[computed]" : exported(name)
        if (banned) report(element, banned)
      }
    } else if (ts.isExportSpecifier(parent) && (parent.name.text === "NodeHttpClient")) {
      // Re-exported under its own name: every importer of that name is read as a namespace too.
    } else {
      report(node, "NodeHttpClient as a value")
    }
  }

  const visit = (node) => {
    if (ts.isIdentifier(node) && !notARead(node) && isNamespace(node)) namespaceRead(node)
    else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isNamespace(node)) namespaceRead(node)
    if (
      ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
      && clientModule.test(node.arguments[0].text)
    ) {
      report(node, "NodeHttpClient loaded dynamically")
    }
    const named = (ts.isIdentifier(node) && !declaresMember(node))
      || (ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
    const key = ts.isStringLiteralLike(node) && !named
    if (named || key) {
      const text = ts.isIdentifier(node) ? ts.idText(node) : node.text
      for (const { pattern, name } of banned) {
        if (key ? exact(pattern).test(text) : pattern.test(text)) report(node, name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...found]
}

/**
 * The one file allowed to name them in code: the constructor that wraps them.
 * Anything else added here has to carry the sentence that says why the
 * environment's proxy does not apply to it.
 */
const defines = "packages/smithers/flows/platform-node/src/EgressHttpClient.ts"

describe("the outbound HTTP client shipped compositions install", () => {
  it("reads shipped source from every tree that composes a Node host", () => {
    const found = sources()
    assert.ok(found.length > 500, `only ${found.length} shipped sources found under ${scanned.join(", ")}`)
    for (const tree of scanned) {
      assert.ok(found.some((path) => path.startsWith(`${tree}/`)), `no shipped source found under ${tree}/`)
    }
    // Named files, not a count: a count stays green while a whole package
    // tree silently leaves the scan. Pruning the bare name `build` at any
    // depth is exactly how the first two of these were invisible to this gate,
    // and the first is one of the sites the gate was written for.
    for (const path of [
      "packages/smithers/build/build-cli/src/internal/rules/FetchExecutor.ts",
      "packages/smithers/src/internal/NodeControlHost.ts",
      ".smithers/flows/coding/evaluator.ts"
    ]) {
      assert.ok(found.includes(path), `${path} is shipped source this gate never read`)
    }
  })

  it("installs the environment's client everywhere, and the bare pool nowhere", () => {
    const offenders = []
    let installs = 0
    for (const path of sources()) {
      let content
      try {
        content = readFileSync(join(root, path), "utf8")
      } catch {
        continue
      }
      if (content.includes("EgressHttpClient.layer(") || content.includes("layerEgressHttpClient(")) installs += 1
      if (path === defines) continue
      for (const use of bannedUses(path, content)) offenders.push(`${path}:${use}`)
    }
    // A gate whose subject has vanished is a gate that cannot fail. The
    // replacement has to be installed somewhere for the ban to mean anything.
    assert.ok(installs >= 10, `the environment's client is installed in only ${installs} shipped sources`)
    assert.deepEqual(
      offenders,
      [],
      "a bare Undici pool ignores HTTP_PROXY/HTTPS_PROXY and dials every origin directly, so a host inside a "
        + "default-deny sandbox reaches nothing. Install `EgressHttpClient.layer(environment)` from "
        + "`@smthrs/platform-node`, which is the same plain pool when no proxy is named:\n  "
        + offenders.join("\n  ")
    )
  })
})

describe("the egress gate's own reading", () => {
  it("scans every JavaScript, TypeScript and VibeLang extension, never a declaration or test", () => {
    for (const name of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.vibe"]) {
      assert.ok(isSource(name), `${name} is shipped source`)
    }
    for (const name of ["a.d.ts", "a.d.mts", "a.d.cts", "a.test.js", "a.spec.cjs", "a.test.tsx", "a.test.mjs", "a.test.vibe", "a.json", "a.md"]) {
      assert.ok(!isSource(name), `${name} is not shipped source`)
    }
  })

  it("exempts comments by parsing, not by line prefix", () => {
    assert.deepEqual(bannedUses("a.ts", "// layerUndici is banned\n/** makeDispatcher too */\nconst x = 1\n"), [])
    assert.deepEqual(bannedUses("a.ts", "/* ok */ Layer.provide(NodeHttpClient.layerUndici)\n"), ["1 NodeHttpClient.layerUndici"])
    assert.deepEqual(bannedUses("a.js", "const n = 2\n  * NodeHttpClient.makeDispatcher().x\n"), ["2 NodeHttpClient.makeDispatcher"])
    assert.deepEqual(bannedUses("a.cjs", "const c = NodeHttpClient[\"layerUndici\"]\n"), ["1 NodeHttpClient.layerUndici"])
    assert.deepEqual(bannedUses("a.jsx", "const c = <X layer={NodeHttpClient.layerUndici} />\n"), ["1 NodeHttpClient.layerUndici"])
    assert.deepEqual(bannedUses("a.ts", "const ok = NodeHttpClient.layerUndiciNoDispatcher\n"), [])
    assert.deepEqual(bannedUses("a.ts", "const prose = \"a bare layerUndici ignores the proxy\"\n"), [])
    assert.deepEqual(bannedUses("a.ts", "const k = \"layerUndici\"\nLayer.provide(NodeHttpClient[k])\n"), ["1 NodeHttpClient.layerUndici"])
    assert.deepEqual(bannedUses("a.ts", "const k = `makeDispatcher`\n"), ["1 NodeHttpClient.makeDispatcher"])
    assert.deepEqual(bannedUses("a.ts", "Layer.provide(NodeHttpClient.layer\\u0055ndici)\n"), ["1 NodeHttpClient.layerUndici"])
    const vibe = "const HttpLive = Layer.effect(Http) {\n  return NodeHttpClient.layerUndici\n}\n"
    assert.deepEqual(bannedUses("a.vibe", vibe), ["2 NodeHttpClient.layerUndici"])
  })

  it("passes a member that only shares the name, and still fails a read, a destructure or a pass-through", () => {
    // Effect's Scheduler shape, as packages/fuzz/src/internal/fuzz/simulation.ts implements it.
    const scheduler = "const s: Scheduler.Scheduler = {\n  executionMode: \"sync\",\n  makeDispatcher: () => ({ scheduleTask, flush })\n}\n"
    assert.deepEqual(bannedUses("a.ts", scheduler), [])
    assert.deepEqual(bannedUses("a.ts", "class S implements Scheduler {\n  makeDispatcher() { return d }\n  get layerUndici() { return 1 }\n}\n"), [])
    assert.deepEqual(bannedUses("a.ts", "interface S { makeDispatcher(): D; layerUndici: L }\n"), [])
    assert.deepEqual(bannedUses("a.ts", "const { makeDispatcher } = NodeHttpClient\n"), ["1 NodeHttpClient.makeDispatcher"])
    assert.deepEqual(bannedUses("a.ts", "const x = { makeDispatcher }\n"), ["1 NodeHttpClient.makeDispatcher"])
    assert.deepEqual(bannedUses("a.ts", "const x = { layer: layerUndici }\n"), ["1 NodeHttpClient.layerUndici"])
    assert.deepEqual(
      bannedUses("a.ts", "const x = { makeDispatcher: NodeHttpClient.makeDispatcher }\n"),
      ["1 NodeHttpClient.makeDispatcher"]
    )
  })

  it("refuses every NodeHttpClient export but the context-taking ones, however the module is bound", () => {
    const client = "import * as NodeHttpClient from \"@effect/platform-node/NodeHttpClient\"\n"
    assert.deepEqual(bannedUses("a.ts", `${client}Layer.provide(NodeHttpClient.layerUndiciOptions({}))\n`), [
      "2 NodeHttpClient.layerUndiciOptions"
    ])
    assert.deepEqual(
      bannedUses("a.ts", `${client}NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(NodeHttpClient.layerDispatcher))\n`),
      ["2 NodeHttpClient.layerDispatcher"]
    )
    for (const name of ["makeDispatcherOptions", "layerDispatcherOptions", "dispatcherLayerGlobal", "layerNodeHttp",
      "layerNodeHttpOptions", "layerAgent", "makeAgent", "layerFetch"]) {
      assert.deepEqual(bannedUses("a.ts", `${client}const x = NodeHttpClient.${name}\n`), [`2 NodeHttpClient.${name}`], name)
    }
    assert.deepEqual(
      bannedUses("a.ts", `${client}const c = NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, d))\n`
        + "const o: NodeHttpClient.UndiciOptions = {}\nconst l = NodeHttpClient.layerUndiciNoDispatcher\n"),
      []
    )
    // Every way of binding the module, and every way of reading the binding.
    assert.deepEqual(bannedUses("a.ts", "import { NodeHttpClient as H } from \"@effect/platform-node\"\nH.layerAgent\n"), [
      "2 NodeHttpClient.layerAgent"
    ])
    assert.deepEqual(bannedUses("a.ts", "import { NodeHttpClient } from \"@smthrs/platform-node/NodeHost\"\nNodeHttpClient.layerNodeHttp\n"), [
      "2 NodeHttpClient.layerNodeHttp"
    ])
    assert.deepEqual(bannedUses("a.ts", "import * as P from \"@effect/platform-node\"\nP.NodeHttpClient.layerDispatcher\n"), [
      "2 NodeHttpClient.layerDispatcher"
    ])
    assert.deepEqual(bannedUses("a.ts", 'import * as P from "@effect/platform-node"\nP["NodeHttpClient"].layerDispatcher\n'), [
      "2 NodeHttpClient.layerDispatcher"
    ])
    assert.deepEqual(bannedUses("a.ts", 'import * as P from "@effect/platform-node"\nP["NodeHttpClient"].layerUndiciNoDispatcher\n'), [])
    assert.deepEqual(bannedUses("a.ts", "import { layerDispatcher as d, makeUndici } from \"@effect/platform-node/NodeHttpClient\"\n"), [
      "1 NodeHttpClient.layerDispatcher"
    ])
    assert.deepEqual(bannedUses("a.ts", `${client}NodeHttpClient["layerAgent"]\n`), ["2 NodeHttpClient.layerAgent"])
    assert.deepEqual(bannedUses("a.ts", `${client}NodeHttpClient[k]\n`), ["2 NodeHttpClient[computed]"])
    assert.deepEqual(bannedUses("a.ts", `${client}const { makeUndici, layerNodeHttp: l } = NodeHttpClient\n`), [
      "2 NodeHttpClient.layerNodeHttp"
    ])
    assert.deepEqual(bannedUses("a.ts", `${client}const alias = NodeHttpClient\n`), ["2 NodeHttpClient as a value"])
    assert.deepEqual(bannedUses("a.ts", `${client}use({ NodeHttpClient })\n`), ["2 NodeHttpClient as a value"])
    assert.deepEqual(bannedUses("a.ts", "export * from \"@effect/platform-node/NodeHttpClient\"\n"), ["1 NodeHttpClient.*"])
    assert.deepEqual(bannedUses("a.ts", "export { layerAgent } from \"@effect/platform-node/NodeHttpClient\"\n"), [
      "1 NodeHttpClient.layerAgent"
    ])
    assert.deepEqual(bannedUses("a.ts", "const m = await import(\"@effect/platform-node/NodeHttpClient\")\n"), [
      "1 NodeHttpClient loaded dynamically"
    ])
    assert.deepEqual(bannedUses("a.cjs", "const m = require(\"@effect/platform-node/NodeHttpClient\")\n"), [
      "1 NodeHttpClient loaded dynamically"
    ])
    // A host re-exporting the namespace under its own name is read where it is imported.
    assert.deepEqual(bannedUses("a.ts", `${client}export { NodeHttpClient }\n`), [])
    assert.deepEqual(bannedUses("a.ts", `${client}export { NodeHttpClient as Http }\n`), ["2 NodeHttpClient as a value"])
    // A member of another object that shares the name is not the module.
    assert.deepEqual(bannedUses("a.ts", "WorkspaceSandbox.layerDispatcher(d)\nexport const layerDispatcher = 1\n"), [])
    assert.deepEqual(bannedUses("a.ts", `${client}// NodeHttpClient.layerAgent is banned\n`), [])
  })

  it("reads a symlinked source file and a symlinked directory, and survives a link loop", () => {
    const fixture = mkdtempSync(join(tmpdir(), "egress-gate-"))
    try {
      mkdirSync(join(fixture, "packages/q/src"), { recursive: true })
      mkdirSync(join(fixture, "packages/q/test"), { recursive: true })
      writeFileSync(join(fixture, "packages/q/test/real.ts"), "Layer.provide(NodeHttpClient.layerUndici)\n")
      symlinkSync("../test/real.ts", join(fixture, "packages/q/src/Bad.ts"))
      symlinkSync("../test", join(fixture, "packages/q/src/linked"))
      symlinkSync("..", join(fixture, "packages/q/src/loop"))
      const found = sources(fixture)
      assert.ok(found.includes("packages/q/src/Bad.ts"), found.join(","))
      assert.ok(found.includes("packages/q/src/linked/real.ts"), found.join(","))
      assert.deepEqual(bannedUses("Bad.ts", readFileSync(join(fixture, "packages/q/src/Bad.ts"), "utf8")), [
        "1 NodeHttpClient.layerUndici"
      ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
