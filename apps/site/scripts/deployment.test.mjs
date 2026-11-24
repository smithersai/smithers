/** Validate real Alchemy entry points offline; never evaluate or deploy a stack. */
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { docsRoutes, workerDomain } from "../../mvp/infra/Domain.ts"

const root = resolve(import.meta.dirname, "../../..")
const appEntries = ["bug-worker"].map((name) => join(root, "apps", name, "alchemy.run.ts"))

test("all deployment entry points import as Alchemy 2 stack effects", async () => {
  const entryPoints = [
    ...appEntries
  ]
  for (const path of entryPoints) {
    const module = await import(pathToFileURL(path).href)
    assert.ok(Effect.isEffect(module.default), `${path}: the CLI needs a default-exported stack effect`)
  }
})

test("stack properties and shared implementation typecheck against the declared Alchemy API", () => {
  const program = ts.createProgram({
    rootNames: [
      ...appEntries
    ],
    options: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext
    }
  })
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
    diagnostic.category === ts.DiagnosticCategory.Error
  )
  assert.equal(
    errors.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    })
  )
})

/** A fixture installation of the bug Worker: its deployment configuration as the environment supplies it. */
const BUG_WORKER_FIXTURE = {
  BUG_WORKER_NAME: "fixture-bug-worker",
  BUG_REPORTS_NAMESPACE: "fixture-bug-reports",
  BUG_WORKER_DOMAIN: "bug.example.com",
  BUG_WORKER_DOMAIN_ALIASES: "bugs.example.com"
}
const bugWorkerDeployment = async (env) => {
  const { BugWorkerDeployment } = await import(pathToFileURL(join(root, "apps/bug-worker/infra/Deployment.ts")).href)
  return Effect.runSync(BugWorkerDeployment.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))
}

test("app stacks take Worker routing from deployment configuration and defer required redacted credentials", async () => {
  const [bugs] = await Promise.all(appEntries.map((path) => import(pathToFileURL(path).href)))
  // The physical names and hostnames are the installation's configuration,
  // never a hosted account's literals: another installation plans its own.
  const configured = bugs.workerProps(await bugWorkerDeployment(BUG_WORKER_FIXTURE))
  assert.equal(configured.name, "fixture-bug-worker")
  assert.equal(bugs.bugReportsProps(await bugWorkerDeployment(BUG_WORKER_FIXTURE)).title, "fixture-bug-reports")
  assert.equal(configured.main, "src/worker.ts")
  assert.deepEqual(configured.domain, { name: "bug.example.com", aliases: ["bugs.example.com"] })
  // A workers.dev origin would serve the same routes outside the custom domain's zone rules.
  assert.equal(configured.workersDev, false)
  assert.equal(configured.env.PUBLIC_BASE_URL, "https://bug.example.com")
  const generic = bugs.workerProps(await bugWorkerDeployment({}))
  assert.equal(generic.name, "smithers-bug-worker")
  assert.equal(generic.domain, undefined)
  assert.equal(generic.workersDev, true)
  assert.equal("PUBLIC_BASE_URL" in generic.env, false)
  assert.equal(configured.crons, undefined)
  for (const retired of ["REPO_COMPLETIONS", "RESEND_API_KEY", "NOTIFICATION_FROM", "GITHUB_FORK_TOKEN"]) {
    assert.equal(retired in configured.env, false)
  }
  assert.ok(Effect.isEffect(configured.env.BUGS))

  // A deploy from a shell without a binding's variable must fail, not delete the binding.
  const credentials = [[configured.env.BUG_ADMIN_TOKEN, "BUG_ADMIN_TOKEN"]]
  for (const [config, name] of credentials) {
    assert.ok(Config.isConfig(config), `${name}: resolve credentials only while evaluating the stack`)
    assert.equal(Effect.runSyncExit(config.parse(ConfigProvider.fromUnknown({})))._tag, "Failure")
    assert.equal(Effect.runSyncExit(config.parse(ConfigProvider.fromUnknown({ [name]: "  " })))._tag, "Failure")
    const value = Effect.runSync(
      config.parse(ConfigProvider.fromUnknown({ [name]: "  deployment-test-placeholder  " }))
    )
    assert.ok(Redacted.isRedacted(value))
    assert.equal(Redacted.value(value), "deployment-test-placeholder")
  }
})

/**
 * The hostnames a stack's Workers claim, read from source without running any of it: each `domain` (its name,
 * aliases and redirects) and each route `pattern` in every file of the stack's relative import graph that imports
 * `@alchemy.run/cloudflare`. Running a stack would load its whole app under Node; Vite and Alchemy bundle that code, and
 * Node's loader rejects its extensionless imports. Configured claims are resolved through their pure routing helpers
 * with an injected deployment hostname; `bindingModules` names the module each stack's helper must be imported from.
 * Any other nonliteral claim still fails closed.
 */
const stackHostnames = (stackPath, bindings = new Map(), bindingModules = new Map()) => {
  const claims = []
  const seen = new Set()
  const pending = [stackPath]
  while (pending.length > 0) {
    const path = pending.pop()
    if (seen.has(path)) continue
    seen.add(path)
    const text = readFileSync(path, "utf8")
    const imports = ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName)
    for (const specifier of imports.filter((name) => name.startsWith("."))) {
      const base = resolve(dirname(path), specifier)
      const file = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]
        .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate))
      if (file !== undefined) pending.push(file)
    }
    if (!imports.includes("@alchemy.run/cloudflare")) continue
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const where = (node) =>
      `${relative(root, path)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    const bare = (node) => {
      while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
        node = node.expression
      }
      return node
    }
    const unreadable = (node) =>
      `${where(node)}: declare hostnames as literals, so this test reads them without running the stack`
    const fields = (node) => {
      const object = bare(node)
      assert.ok(ts.isObjectLiteralExpression(object), unreadable(node))
      return new Map(
        object.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [[property.name.text, property.initializer]]
            : []
        )
      )
    }
    const value = (node) => {
      const expression = bare(node)
      const bound = bindings.get(path)?.get(expression.getText(source))
      if (bound !== undefined) {
        assert.ok(
          ts.isCallExpression(expression) &&
            source.statements.some((statement) =>
              ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
              resolve(dirname(path), statement.moduleSpecifier.text) === bindingModules.get(path) &&
              statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
              statement.importClause.namedBindings.elements.some((entry) =>
                entry.name.text === expression.expression.getText(source) &&
                (entry.propertyName?.text ?? entry.name.text) === entry.name.text
              )
            ),
          unreadable(node)
        )
        return bound
      }
      if (ts.isStringLiteralLike(expression)) return expression.text
      if (ts.isArrayLiteralExpression(expression)) return expression.elements.map(value)
      if (ts.isObjectLiteralExpression(expression)) {
        assert.ok(expression.properties.every(ts.isPropertyAssignment), unreadable(node))
        return Object.fromEntries([...fields(expression)].map(([key, entry]) => [key, value(entry)]))
      }
      assert.fail(unreadable(node))
    }
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          const key =
            property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
              ? property.name.text
              : undefined
          if ((key === "domain" || key === "routes") && !ts.isPropertyAssignment(property)) {
            assert.fail(unreadable(property))
          }
        }
        const props = fields(node)
        const name = props.get("name")
        const owner = name !== undefined && ts.isStringLiteralLike(bare(name)) ? bare(name).text : where(node)
        const domain = props.get("domain")
        if (domain !== undefined && bare(domain).kind !== ts.SyntaxKind.NullKeyword) {
          const declared = value(domain)
          const hosts = typeof declared === "string"
            ? [declared]
            : [declared.name, ...declared.aliases ?? [], ...declared.redirects ?? []]
          for (const host of hosts) {
            assert.equal(typeof host, "string", unreadable(domain))
            claims.push({ host, owner, kind: "domain", path: "/*" })
          }
        }
        const routes = props.get("routes")
        if (routes !== undefined) {
          const declared = value(routes)
          assert.ok(Array.isArray(declared), unreadable(routes))
          for (const route of declared) {
            assert.equal(typeof route.pattern, "string", unreadable(routes))
            const slash = route.pattern.indexOf("/")
            claims.push({
              host: slash === -1 ? route.pattern : route.pattern.slice(0, slash),
              owner,
              kind: route.custom_domain ? "domain" : "route",
              path: slash === -1 ? "/*" : route.pattern.slice(slash)
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return claims
}

const conflicts = (claims) =>
  claims.flatMap((left, index) =>
    claims.slice(index + 1).flatMap((right) => {
      if (left.host !== right.host || left.owner === right.owner) return []
      // The app owns its custom domain; docs zone routes own only their paths.
      // A whole-host route would still hide the app, and two routes may not overlap.
      const overlaps = left.kind !== right.kind
        ? (left.kind === "route" ? left.path : right.path) === "/*"
        : left.kind === "domain" || (left.path.endsWith("*") && right.path.startsWith(left.path.slice(0, -1))) ||
          (right.path.endsWith("*") && left.path.startsWith(right.path.slice(0, -1))) || left.path === right.path
      return overlaps ? [`${left.host}: ${left.owner} ${left.path}, ${right.owner} ${right.path}`] : []
    })
  )

test("each hostname and route has one owning Worker in this repository", async () => {
  const owners = new Map()
  const claims = []
  const claim = (entry) => {
    assert.match(entry.path, /^[^*]*\*?$/, "route inventory supports only a trailing path wildcard")
    claims.push(entry)
    owners.set(entry.host, new Set([...(owners.get(entry.host) ?? []), entry.owner]))
  }
  const host = {
    name: "example.com",
    redirects: ["www.example.com"],
    aliases: [{ host: "factory.example.com", path: "/acme/widgets/-/factory" }]
  }
  const { bugWorkerDomain } = await import(pathToFileURL(join(root, "apps/bug-worker/infra/Deployment.ts")).href)
  const bindings = new Map([
    [join(root, "apps/mvp/alchemy.run.ts"), new Map([["workerDomain(domain.value)", workerDomain(host)]])],
    [join(root, "apps/mvp/infra/DocsSite.ts"), new Map([["docsRoutes(domain)", docsRoutes(host.name)]])],
    [
      join(root, "apps/bug-worker/alchemy.run.ts"),
      new Map([["bugWorkerDomain(deployment)", bugWorkerDomain(await bugWorkerDeployment(BUG_WORKER_FIXTURE))]])
    ]
  ])
  const bindingModules = new Map([
    [join(root, "apps/mvp/alchemy.run.ts"), join(root, "apps/mvp/infra/Domain.ts")],
    [join(root, "apps/mvp/infra/DocsSite.ts"), join(root, "apps/mvp/infra/Domain.ts")],
    [join(root, "apps/bug-worker/alchemy.run.ts"), join(root, "apps/bug-worker/infra/Deployment.ts")]
  ])
  const apps = join(root, "apps")
  // The site's docs redirect Worker (apps/site/docs-redirect) is the one
  // Worker nested below an app directory.
  const wranglerPaths = [
    ...readdirSync(apps).map((app) => join(apps, app, "wrangler.jsonc")),
    join(apps, "site", "docs-redirect", "wrangler.jsonc")
  ]
  for (const wranglerPath of wranglerPaths) {
    if (existsSync(wranglerPath)) {
      const { config, error } = ts.parseConfigFileTextToJson(wranglerPath, readFileSync(wranglerPath, "utf8"))
      assert.equal(error, undefined, wranglerPath)
      for (const route of config.routes ?? []) {
        const slash = route.pattern.indexOf("/")
        claim({
          host: slash === -1 ? route.pattern : route.pattern.slice(0, slash),
          owner: config.name,
          kind: route.custom_domain ? "domain" : "route",
          path: slash === -1 ? "/*" : route.pattern.slice(slash)
        })
      }
    }
  }
  for (const app of readdirSync(apps)) {
    const stackPath = join(apps, app, "alchemy.run.ts")
    if (existsSync(stackPath)) {
      for (const entry of stackHostnames(stackPath, bindings, bindingModules)) claim(entry)
    }
  }
  // An empty static read must not pass for "no conflicts": it sees bug-worker's configured domain.
  for (const host of ["bug.example.com", "bugs.example.com"]) {
    assert.equal(owners.get(host)?.size, 1, host)
  }
  // The docs redirect Worker's routes are read too: one retired docs site.
  assert.deepEqual([...owners.get("flows.smithers.sh") ?? []], ["smithers-docs-redirect"])
  assert.equal(claims.filter((entry) => entry.host === host.name && entry.kind === "domain").length, 1)
  // An APP_ALIASES hostname is another custom domain of the app Worker, owned by it alone.
  const app = claims.find((entry) => entry.host === host.name && entry.kind === "domain")?.owner
  assert.deepEqual([...owners.get("factory.example.com") ?? []], [app])
  assert.deepEqual(
    claims.filter((entry) => entry.host === host.name && entry.kind === "route").map((entry) => entry.path),
    docsRoutes(host.name).map((entry) => entry.pattern.slice(host.name.length))
  )
  assert.deepEqual(conflicts(claims), [])
})

test("route ownership permits scoped docs and refuses duplicate domains, overlapping routes and whole-host shadows", () => {
  const app = { host: "example.com", owner: "app", kind: "domain", path: "/*" }
  const docs = { ...app, owner: "docs", kind: "route", path: "/docs/*" }
  assert.deepEqual(conflicts([app, docs]), [])
  assert.deepEqual(conflicts([docs, { ...docs, path: "/docs/other/*" }]), [])
  for (const other of [{ ...app, owner: "other" }, { ...docs, path: "/*" }]) {
    assert.equal(conflicts([app, other]).length, 1)
  }
  assert.equal(conflicts([docs, { ...docs, owner: "other", path: "/docs/page" }]).length, 1)
  assert.equal(conflicts([docs, { ...docs, owner: "other", path: "/docs/nested/*" }]).length, 1)
  assert.deepEqual(conflicts([docs, { ...docs, owner: "other", path: "/api/*" }]), [])
})

test("an unknown dynamic domain or route cannot disappear from the inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-route-inventory-"))
  try {
    const path = join(directory, "alchemy.run.ts")
    for (const field of ["domain", "routes"]) {
      writeFileSync(
        path,
        `import * as Cloudflare from "@alchemy.run/cloudflare"\nexport const props = { ${field}: unknownClaim() }\n`
      )
      assert.throws(() => stackHostnames(path), /declare hostnames as literals/)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("every shared-state stack plans against one record under the configured stage", () => {
  const read = (path) => readFileSync(join(root, path), "utf8")
  // Local state lives in a gitignored .alchemy/ on whichever machine deployed
  // last, and the CLI's default stage is dev_$USER, so either one gives each
  // machine its own view of production. The stage is deployment
  // configuration: a command without ALCHEMY_STAGE stops instead of falling
  // back to dev_$USER or to a hosted stage.
  const stacks = [
    { stack: "apps/bug-worker/alchemy.run.ts", pkg: "apps/bug-worker/package.json", qualifiedOnly: true }
  ]
  for (const { stack, pkg, qualifiedOnly } of stacks) {
    const source = read(stack)
    assert.ok(
      source.includes("state: Cloudflare.state()"),
      `${stack}: state must live in the account's alchemy-state-store`
    )
    assert.ok(!source.includes("localState"), `${stack}: local state is one machine's view`)
    const packageScripts = JSON.parse(read(pkg)).scripts
    const scripts = Object.values(packageScripts).filter((script) => script.startsWith("alchemy "))
    assert.deepEqual(
      scripts.sort(),
      [
        "alchemy deploy --dry-run --stage \"${ALCHEMY_STAGE:?set ALCHEMY_STAGE to the stage to plan}\"",
        ...(qualifiedOnly ? [] : ["alchemy deploy --stage \"${ALCHEMY_STAGE:?set ALCHEMY_STAGE to the stage to deploy}\""]),
        "alchemy destroy --stage \"${ALCHEMY_STAGE:?set ALCHEMY_STAGE to the stage to destroy}\""
      ].sort(),
      pkg
    )
    assert.equal(
      packageScripts.deploy,
      qualifiedOnly
        ? "node ../../.smithers/flows/rollout/refuse-unqualified.mjs"
        : "alchemy deploy --stage \"${ALCHEMY_STAGE:?set ALCHEMY_STAGE to the stage to deploy}\"",
      pkg
    )
    if (qualifiedOnly) {
      for (const [name, script] of Object.entries(packageScripts)) {
        if (name !== "plan") {
          assert.doesNotMatch(
            script,
            /\balchemy\s+deploy\b/,
            `${pkg}:${name}: only the qualified Cloud host may deploy`
          )
        }
      }
    }
  }
})

test("bug-worker plan runs only under an explicit ALCHEMY_STAGE", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-plan-stage-"))
  try {
    const marker = join(directory, "argv")
    writeFileSync(join(directory, "alchemy"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "))\n`,
      { mode: 0o755 })
    const plan = JSON.parse(readFileSync(join(root, "apps/bug-worker/package.json"), "utf8")).scripts.plan
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ALCHEMY_STAGE"))
    env.PATH = `${directory}:${env.PATH}`
    const unset = spawnSync("/bin/sh", ["-c", plan], { env, encoding: "utf8" })
    assert.notEqual(unset.status, 0)
    assert.match(unset.stderr, /set ALCHEMY_STAGE/)
    assert.equal(existsSync(marker), false)
    const staged = spawnSync("/bin/sh", ["-c", plan], { env: { ...env, ALCHEMY_STAGE: "fixture" }, encoding: "utf8" })
    assert.equal(staged.status, 0, staged.stderr)
    assert.equal(readFileSync(marker, "utf8"), "deploy --dry-run --stage fixture")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("bug-worker local deploy commands refuse unqualified publication", () => {
  const guard = join(root, ".smithers/flows/rollout/refuse-unqualified.mjs")
  for (const app of ["bug-worker"]) {
    for (const flags of [[], ["--stage", "prod"], ["--adopt", "--stage", "prod"]]) {
      const label = `${app} ${flags.join(" ")}`
      const result = spawnSync(process.execPath, [guard, ...flags], { cwd: join(root, "apps", app), encoding: "utf8" })
      assert.equal(result.status, 1, label)
      assert.equal(result.stdout, "", label)
      assert.match(result.stderr, /Deployment refused: a qualified Cloud rollout is required/, label)
    }
  }
})

test("documented deploy commands hand Alchemy its flags directly", () => {
  // pnpm 11 forwards a literal `--` to the script, and Alchemy's CLI reads
  // every argument after `--` as the main file: `run deploy -- --adopt`
  // looks for a file named --adopt and never adopts.
  const docs = [
    "apps/bug-worker/README.md",
    "apps/bug-worker/alchemy.run.ts"
  ]
  for (const path of docs) {
    assert.doesNotMatch(readFileSync(join(root, path), "utf8"), /(run (plan|deploy|destroy)|docs:deploy) -- /, path)
  }
})
