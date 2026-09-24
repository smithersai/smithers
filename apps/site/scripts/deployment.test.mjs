/** Validate real Alchemy entry points offline; never evaluate or deploy a stack. */
import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import ts from "typescript"
import { sites } from "../../docs/shared/manifest.mjs"

const root = resolve(import.meta.dirname, "../../..")
const appEntries = ["review", "bug-worker", "status-site"].map((name) => join(root, "apps", name, "alchemy.run.ts"))

const appOptions = [
  "REVIEW_ENABLE_SMITHERS_SH_ROUTE",
  "REVIEW_PUBLIC_BASE_URL",
  "STATUS_SITE_DOMAIN",
  "CLOUDFLARE_SMITHERS_ZONE_ID"
]

let mainSiteImport = 0
const importMainSite = async (overrides = {}) => {
  const names = ["SMITHERS_SITE_DOMAIN", "SMITHERS_SITE_WORKER_NAME", "CLOUDFLARE_SMITHERS_ZONE_ID"]
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  try {
    for (const name of names) {
      if (overrides[name] === undefined) delete process.env[name]
      else process.env[name] = overrides[name]
    }
    return await import(`${pathToFileURL(join(root, "apps/site/alchemy.run.ts")).href}?main-site-${mainSiteImport++}`)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("the main site defaults to its dedicated Worker and agrees with Wrangler", async () => {
  const site = await importMainSite()
  const wranglerPath = join(root, "apps/site/wrangler.jsonc")
  const wrangler = ts.parseConfigFileTextToJson(wranglerPath, readFileSync(wranglerPath, "utf8"))
  assert.equal(wrangler.error, undefined)
  assert.ok(Effect.isEffect(site.default))
  assert.equal(site.siteProps.name, "smithers-site-v1")
  assert.equal(site.siteProps.name, wrangler.config.name)
  assert.equal(site.siteProps.command, "pnpm run build")
  assert.equal(site.siteProps.outdir, wrangler.config.assets.directory)
  assert.equal(site.siteProps.compatibility.date, wrangler.config.compatibility_date)
  assert.equal(site.siteProps.workersDev, wrangler.config.workers_dev)
  assert.equal(site.siteProps.assets.notFoundHandling, wrangler.config.assets.not_found_handling)
  assert.deepEqual(site.siteProps.domain, { name: wrangler.config.routes[0].pattern })
  assert.equal(site.siteProps.domain.name, "smithers.sh")
})

test("main-site overrides preserve separate preview identity and refuse an unnamed preview", async () => {
  const preview = await importMainSite({
    SMITHERS_SITE_DOMAIN: " preview.example.test ",
    SMITHERS_SITE_WORKER_NAME: " smithers-site-preview-test ",
    CLOUDFLARE_SMITHERS_ZONE_ID: " test-zone "
  })
  assert.ok(Effect.isEffect(preview.default))
  assert.equal(preview.siteProps.name, "smithers-site-preview-test")
  assert.deepEqual(preview.siteProps.domain, { name: "preview.example.test", zoneId: "test-zone" })
  const apex = await importMainSite({ SMITHERS_SITE_WORKER_NAME: " explicit-main-site-test " })
  assert.equal(apex.siteProps.name, "explicit-main-site-test")
  assert.deepEqual(apex.siteProps.domain, { name: "smithers.sh" })
  for (const workerName of [undefined, "", "  "]) {
    await assert.rejects(
      importMainSite({ SMITHERS_SITE_DOMAIN: "preview.example.test", SMITHERS_SITE_WORKER_NAME: workerName }),
      /Set SMITHERS_SITE_WORKER_NAME to a separate Worker name for a preview domain/
    )
  }
})

test("all deployment entry points import as Alchemy 2 stack effects", async (t) => {
  const overrides = new Map()
  const set = (name, value) => {
    overrides.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of overrides) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  set("SMITHERS_SITE_DOMAIN", undefined)
  set("SMITHERS_SITE_WORKER_NAME", undefined)
  for (const name of appOptions) set(name, undefined)
  const entryPoints = [join(root, "apps/site/alchemy.run.ts"), ...appEntries]
  for (const site of sites) {
    set(`${site.slug.toUpperCase().replaceAll("-", "_")}_WORKER_NAME`, `docs-test-${site.slug}`)
    entryPoints.push(join(site.siteDir, "alchemy.run.ts"))
  }
  for (const path of entryPoints) {
    const module = await import(pathToFileURL(path).href)
    assert.ok(Effect.isEffect(module.default), `${path}: the CLI needs a default-exported stack effect`)
  }
})

test("stack properties and shared implementation typecheck against the declared Alchemy API", () => {
  const program = ts.createProgram({
    rootNames: [
      join(root, "apps/site/alchemy.run.ts"),
      ...appEntries,
      join(root, "apps/docs/shared/alchemy-site.mjs"),
      ...sites.map((site) => join(site.siteDir, "alchemy.run.ts"))
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

test("app stacks retain their Worker routing and defer required redacted credentials", async () => {
  const [review, bugs, status] = await Promise.all(appEntries.map((path) => import(pathToFileURL(path).href)))
  assert.equal(review.workerProps.name, "smithers-review")
  assert.equal(review.workerProps.main, "src/server/worker.ts")
  assert.deepEqual(review.workerProps.domain, { name: "review.jjhub.tech", zoneId: "72854846f57d9e46794e7e6aae7e3328" })
  assert.deepEqual(review.workerProps.routes, [])
  assert.equal(review.workerProps.env.PUBLIC_BASE_URL, "https://review.jjhub.tech")
  assert.ok(Effect.isEffect(review.workerProps.env.WALKTHROUGHS))
  assert.ok(Effect.isEffect(review.workerProps.env.DB))

  // The live Worker, KV namespace and hostnames observed on Cloudflare 2026-09-23.
  // Another name creates a second Worker and an empty namespace; a declared
  // domain detaches every live hostname it does not list.
  assert.equal(bugs.workerProps.name, "smithers-bug-worker-smithers-bug-worker-williamcory")
  assert.equal(bugs.bugReportsProps.title, "smithers-bug-worker-bug-reports-williamcory")
  assert.equal(bugs.workerProps.main, "src/worker.ts")
  assert.deepEqual(bugs.workerProps.domain, { name: "bug.smithers.sh", aliases: ["bugs.smithers.sh"], zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14" })
  // A workers.dev origin would serve the same routes outside the smithers.sh zone's rules.
  assert.equal(bugs.workerProps.workersDev, false)
  assert.deepEqual(bugs.workerProps.crons, ["*/10 * * * *"])
  assert.equal(bugs.workerProps.env.PUBLIC_BASE_URL, "https://bug.smithers.sh")
  assert.ok(Effect.isEffect(bugs.workerProps.env.BUGS))
  // Local state and the CLI's default dev_$USER stage give each machine its own view of production.
  const bugStack = readFileSync(join(root, "apps/bug-worker/alchemy.run.ts"), "utf8")
  assert.ok(bugStack.includes("state: Cloudflare.state()") && !bugStack.includes("localState"))
  const bugScripts = JSON.parse(readFileSync(join(root, "apps/bug-worker/package.json"), "utf8")).scripts
  assert.deepEqual(Object.values(bugScripts).filter((script) => script.startsWith("alchemy ")).sort(), [
    "alchemy deploy --dry-run --stage prod",
    "alchemy deploy --stage prod",
    "alchemy destroy --stage prod"
  ])

  // A deploy from a shell without a binding's variable must fail, not delete the binding.
  const sender = bugs.workerProps.env.NOTIFICATION_FROM
  assert.ok(Config.isConfig(sender), "NOTIFICATION_FROM: resolve only while evaluating the stack")
  assert.equal(Effect.runSyncExit(sender.parse(ConfigProvider.fromUnknown({})))._tag, "Failure")
  assert.equal(Effect.runSyncExit(sender.parse(ConfigProvider.fromUnknown({ NOTIFICATION_FROM: "  " })))._tag, "Failure")
  assert.equal(
    Effect.runSync(sender.parse(ConfigProvider.fromUnknown({ NOTIFICATION_FROM: " Smithers <reports@example.test> " }))),
    "Smithers <reports@example.test>"
  )

  const credentials = [
    [review.workerProps.env.REVIEW_PUBLISH_TOKEN, "REVIEW_PUBLISH_TOKEN"],
    [review.workerProps.env.ADMIN_TOKEN, "REVIEW_ADMIN_TOKEN"],
    [review.workerProps.env.METRICS_TOKEN, "REVIEW_METRICS_TOKEN"],
    [review.workerProps.env.ANTHROPIC_API_KEY, "REVIEW_ANTHROPIC_API_KEY"],
    [bugs.workerProps.env.BUG_ADMIN_TOKEN, "BUG_ADMIN_TOKEN"],
    [bugs.workerProps.env.RESEND_API_KEY, "RESEND_API_KEY"],
    [bugs.workerProps.env.GITHUB_FORK_TOKEN, "GITHUB_FORK_TOKEN"]
  ]
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

  const wranglerPath = join(root, "apps/status-site/wrangler.jsonc")
  const wrangler = ts.parseConfigFileTextToJson(wranglerPath, readFileSync(wranglerPath, "utf8"))
  assert.equal(wrangler.error, undefined)
  assert.equal(status.workerProps.name, wrangler.config.name)
  assert.equal(status.workerProps.main, wrangler.config.main)
  assert.equal(status.workerProps.compatibility.date, wrangler.config.compatibility_date)
  assert.equal(status.workerProps.workersDev, wrangler.config.workers_dev)
  assert.equal(status.workerProps.domain.name, wrangler.config.routes[0].pattern)
  assert.equal(status.workerProps.assets.directory, resolve(root, "apps/status-site", wrangler.config.assets.directory))
  assert.equal(wrangler.config.assets.binding, "ASSETS")
  assert.equal(status.workerProps.assets.notFoundHandling, wrangler.config.assets.not_found_handling)
  assert.equal(status.workerProps.assets.runWorkerFirst, wrangler.config.assets.run_worker_first)
  assert.deepEqual(status.workerProps.observability, wrangler.config.observability)
})

test("app stack overrides preserve the optional route, bindings, domain and zone", async (t) => {
  const previous = new Map(appOptions.map((name) => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  Object.assign(process.env, {
    REVIEW_ENABLE_SMITHERS_SH_ROUTE: "1",
    REVIEW_PUBLIC_BASE_URL: " https://review-preview.example ",
    STATUS_SITE_DOMAIN: " status-preview.example ",
    CLOUDFLARE_SMITHERS_ZONE_ID: " test-zone "
  })
  const [review, , status] = await Promise.all(
    appEntries.map((path) => import(`${pathToFileURL(path).href}?deployment-overrides`))
  )
  assert.deepEqual(review.workerProps.routes, [{
    pattern: "review.smithers.sh/*",
    zoneId: "8ebd98d2f0dc7d8db2e61f31ebc19c14"
  }])
  assert.equal(review.workerProps.env.PUBLIC_BASE_URL, "https://review-preview.example")
  assert.deepEqual(status.workerProps.domain, { name: "status-preview.example", zoneId: "test-zone" })
})

test("package stacks require an explicit physical Worker identity", async () => {
  const { makeDocsSiteStack } = await import("../../docs/shared/alchemy-site.mjs")
  const key = "UNCONFIGURED_DOCS_TEST_WORKER_NAME"
  const previous = process.env[key]
  delete process.env[key]
  try {
    assert.throws(() => makeDocsSiteStack({ slug: "unconfigured-docs-test" }), /Set UNCONFIGURED_DOCS_TEST_WORKER_NAME/)
  } finally {
    if (previous !== undefined) process.env[key] = previous
  }
})
