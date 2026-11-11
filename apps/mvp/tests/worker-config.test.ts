// Alchemy captures Config only while building the program. Walk runtime callbacks and their worker-owned Effect,
// Layer and function dependencies, so an imported Config or a lazy Config layer cannot hide behind a helper.
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, test } from "vitest"

const worker = fileURLToPath(new URL("../worker/", import.meta.url))
const files = readdirSync(worker, { recursive: true }).map(String)
  .filter((file) => file.endsWith(".ts") && !/(?:\.test\.ts|(?:^|\/)test\/)/.test(file))
  .map((file) => worker + file)
const fixture = worker + "__config_fixture.ts"
const source = `
import { Config as Settings, Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/http"
import { enabled as rollout } from "./ci/Dispatch.ts"
const configured = Settings.String("SETTING")
const lazy = Layer.effectDiscard(configured)
export const steps = () => ({ run: () => configured })
export const request = Effect.gen(function* () {
  yield* HttpServerRequest.HttpServerRequest
  yield* Settings.String("DIRECT")
  yield* configured
  yield* rollout
  yield* Effect.void.pipe(Effect.provide(lazy))
})
declare const step: { toLayer: (implementation: unknown) => unknown }
const named = () => Settings.String("NAMED")
const factory = () => () => Settings.String("FACTORY")
step.toLayer(named)
step.toLayer(factory())
export const make = Effect.gen(function* () {
  const value = yield* configured
  return { fetch: Effect.gen(function* () {
    yield* HttpServerRequest.HttpServerRequest
    return value
  }) }
})
`

const config = ts.readConfigFile(worker + "tsconfig.json", ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, worker)
const host = ts.createCompilerHost(parsed.options)
const original = host.getSourceFile.bind(host)
host.getSourceFile = (name, language, error, fresh) => name === fixture
  ? ts.createSourceFile(name, source, language, true)
  : original(name, language, error, fresh)
const program = ts.createProgram([...files, fixture], parsed.options, host)
const checker = program.getTypeChecker()
const owned = new Set([...files, fixture])

const functions = (node: ts.Node): node is ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration | ts.MethodDeclaration =>
  ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)

const runtimeRoots = (file: ts.SourceFile) => {
  const roots: ts.Node[] = []
  const walk = (node: ts.Node) => {
    // A named handler/body is a boundary even if it delegates reading the request to a helper.
    if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
      ["fetch", "handler", "body"].includes(node.name.getText(file)) && node.initializer) roots.push(node.initializer)
    // Every step implementation, including helpers declared inside its factory.
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "steps" && node.initializer) roots.push(node.initializer)
    // The innermost generator reading a request is the handler, not the enclosing build generator.
    if (ts.isPropertyAccessExpression(node) && node.getText(file).endsWith("HttpServerRequest.HttpServerRequest")) {
      let parent: ts.Node | undefined = node.parent
      while (parent && !functions(parent)) parent = parent.parent
      if (parent) roots.push(parent)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["toLayer", "capture", "sync"].includes(node.expression.name.text)) {
      roots.push(...node.arguments)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return roots
}

/**
 * The Config reads reachable at run time from `sources`' runtime roots, each `file:line text` with the file of the first
 * root that reached it, sorted. What a walk finds depends only on the node and whether it is captured, so one sweep
 * shares a visited set per mode: a helper that many roots reach is walked once, not again for every file.
 */
const violations = (sources: ReadonlyArray<ts.SourceFile>) => {
  const found = new Map<string, string>()
  const visited = [new Set<ts.Node>(), new Set<ts.Node>()]
  let root = ""
  const walk = (node: ts.Node, captured = false) => {
    // A yield in a captured initializer already ran while the program built. A callback inside it is deferred.
    if (captured && ts.isYieldExpression(node)) return
    const seen = visited[captured ? 1 : 0]!
    if (seen.has(node) || ts.isTypeNode(node)) return
    seen.add(node)
    if (ts.isExpression(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const type = checker.typeToString(checker.getTypeAtLocation(node))
      if (/^Config(?:\.Config)?</.test(type)) {
        const source = node.getSourceFile()
        const hit = `${source.fileName.slice(worker.length)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText(source)}`
        if (!found.has(hit)) found.set(hit, root)
        return
      }
      // Captured plain values stay captured. Only deferred effects, layers and functions run in the handler.
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node)
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol)
        if (/^(?:Effect(?:\.Effect)?|Layer(?:\.Layer)?)</.test(type) || checker.getTypeAtLocation(node).getCallSignatures().length > 0) {
          for (const declaration of symbol?.declarations ?? []) {
            if (!owned.has(declaration.getSourceFile().fileName)) continue
            if (ts.isVariableDeclaration(declaration) && declaration.initializer &&
              !ts.isYieldExpression(declaration.initializer) &&
              (/^(?:Effect(?:\.Effect)?|Layer(?:\.Layer)?)</.test(type) || functions(declaration.initializer))) {
              walk(declaration.initializer, true)
            }
            if (functions(declaration) && declaration.body) walk(declaration.body)
            if (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration) && declaration.initializer) {
              walk(declaration.initializer!, true)
            }
          }
        }
      }
    }
    ts.forEachChild(node, (child) => walk(child, functions(node) ? false : captured))
  }
  for (const source of sources) {
    root = source.fileName.slice(worker.length)
    runtimeRoots(source).forEach((node) => walk(node))
  }
  return [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
}

test("effect.config-at-build recognizes direct, aliased, imported and deferred reads while allowing captured values", () => {
  const found = violations([program.getSourceFile(fixture)!])
  expect(found.map(([hit]) => hit.slice(hit.indexOf(" ") + 1)).sort()).toEqual([
    'Settings.String("DIRECT")', 'Settings.String("FACTORY")', 'Settings.String("NAMED")', 'configured', 'configured', 'configured', 'rollout',
  ])
})

test("effect.config-at-build: worker steps and request handlers use captured configuration", () => {
  expect(violations(files.map((file) => program.getSourceFile(file)!)).map(([hit, root]) => `${root} -> ${hit}`)).toEqual([])
}, 180_000)
