/** Disposable npm/pnpm consumers of unchanged release manifests or candidate bytes. */
import assert from "node:assert/strict"
import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

import { build as bundle } from "esbuild"
import { satisfies, valid } from "semver"
import {
  EXPECTED_EFFECT_VERSION,
  SUPPORTED_EFFECT_RANGE,
  UNSUPPORTED_EFFECT_VERSION
} from "../../../packages/repo-targets/contracts/check-single-effect-version.mjs"
import { assertEffectFamilyAccepts, assertEffectFamilyInstalled, mcpInitialize } from "./release-mcp-handshake.mjs"
import { captureProcess } from "./release-process.mjs"
import { releaseRegistry } from "./release-registry.mjs"
import { isMain, repoRoot } from "../../../packages/repo-targets/scripts/workspace-packages.mjs"

// The Effect release the repository is tested on, and what every pinned profile
// installs. The published libraries accept the range above it; both are
// declared once, beside the gate that holds the manifests to them.
const effect = EXPECTED_EFFECT_VERSION
const isEffectFamily = (name) => name === "effect" || name.startsWith("@effect/")
const literally = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
/** The package a registry spec names, with or without a scope, a version, a range or a tag. */
export const specName = (spec) => {
  // A leading `@` opens a scope. Any later one starts the version.
  const at = spec.indexOf("@", 1)
  return at === -1 ? spec : spec.slice(0, at)
}
/** Consumer requests must select this candidate, including a future stable cut. */
export const candidateVersion = (entries) => {
  const versions = new Set(entries.map((entry) => entry.version))
  assert.equal(versions.size, 1, "candidate must have one synchronized release version")
  const [version] = versions
  assert.equal(valid(version), version, "candidate release version must be exact semver")
  return version
}
// Temporary projects must select the same pnpm toolchain as the repository.
// Otherwise a different pnpm on a Node-version PATH can change command support.
export const releasePackageManager =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")).packageManager
const stores = new Map()
/** Reuse the workspace's package cache from external consumers without linking its dependencies. */
export const consumerCacheFlags = (manager, workspace = repoRoot, { offline = true } = {}) => {
  // `--prefer-offline` answers a tag or a range from metadata cached on an
  // earlier day. An install that must see what the registry serves now passes
  // `offline: false`: it reads fresh metadata and still reuses package bytes.
  const metadata = offline ? ["--prefer-offline"] : []
  if (manager === "npm") return metadata
  if (manager !== "pnpm") throw new Error(`Unsupported release package manager: ${manager}`)
  if (!stores.has(workspace)) {
    const store = execFileSync("pnpm", ["store", "path"], { cwd: workspace, encoding: "utf8" }).trim()
    if (!isAbsolute(store)) throw new Error(`pnpm store path did not return an absolute directory: ${store}`)
    stores.set(workspace, store)
  }
  return [...metadata, "--store-dir", stores.get(workspace), "--reporter=append-only"]
}
const installedConsumerDirectory = resolve(import.meta.dirname, "fixtures/installed-consumer")
const runners = ["vitest", "@effect/vitest", "@smthrs/testing"]
const nodeRuntime = ["@smthrs/platform-node", "@effect/platform-node", "@effect/platform-node-shared"]
const nodeAdapters = [...nodeRuntime, "@effect/sql-sqlite-node"]
const telemetryAdapters = [
  "@opentelemetry/exporter-logs-otlp-http",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-trace-node",
  "@opentelemetry/sdk-trace-web"
]
const browserAdapters = ["@smthrs/platform-browser", "@smthrs/platform-bun", "@effect/platform-bun"]
const absentByDefault = [...runners, ...nodeAdapters, ...telemetryAdapters, ...browserAdapters, "react", "tsx", "vite"]

// Explicit policy expectations; never derived from the manifest being tested.
export const minimalProfiles = (entries) => {
  const firstParty = candidateVersion(entries)
  return [
    ...["database", "gateway", "observability"].map((name) => ({
      name: name + "-default",
      dependencies: { ["@smthrs/" + name]: firstParty, effect },
      absent: absentByDefault,
      imports: ["@smthrs/" + name]
    })),
    {
      name: "flows-default",
      dependencies: { "@smthrs/flows": firstParty, effect },
      // The barrel names no platform. A Node program installs
      // @smthrs/platform-node, which brings the barrel and the SQLite driver
      // its NodeRuntime opens (#3838), so neither installs with the barrel.
      absent: absentByDefault,
      imports: ["@smthrs/flows"]
    }
  ]
}

export const adapterProfiles = (entries) => {
  const firstParty = candidateVersion(entries)
  return [
    {
      name: "cli-default",
      dependencies: { "@smthrs/cli": firstParty, effect },
      // The executable selects its native host on Node or Bun; libraries keep
      // private adapters; the executable ships both supported SQL backends.
      required: ["@effect/sql-sqlite-node", "@effect/sql-pg"],
      absent: [
        ...runners,
        "@effect/platform-node",
        "@effect/platform-node-shared",
        ...browserAdapters,
        ...telemetryAdapters
      ],
      imports: ["@smthrs/cli"]
    },
    {
      name: "node",
      dependencies: {
        "@smthrs/flows": firstParty,
        "@smthrs/gateway": firstParty,
        "@smthrs/observability": firstParty,
        "@smthrs/platform-node": firstParty,
        "@effect/platform-node": effect,
        "@effect/platform-node-shared": effect,
        "@effect/sql-sqlite-node": effect,
        effect,
        "@opentelemetry/exporter-logs-otlp-http": "0.222.0",
        "@opentelemetry/exporter-metrics-otlp-http": "0.222.0",
        "@opentelemetry/exporter-trace-otlp-http": "0.222.0",
        "@opentelemetry/sdk-trace-base": "2.11.0",
        "@opentelemetry/sdk-trace-node": "2.11.0"
      },
      absent: [...runners, ...browserAdapters, "@opentelemetry/sdk-trace-web"],
      imports: ["@smthrs/platform-node", "@smthrs/gateway/node/NodeGateway", "@smthrs/observability/NodeOtel"]
    },
    {
      name: "browser",
      dependencies: {
        "@smthrs/observability": firstParty,
        "@smthrs/platform-browser": firstParty,
        "@opentelemetry/sdk-trace-base": "2.11.0",
        "@opentelemetry/sdk-trace-web": "2.11.0",
        effect
      },
      absent: [
        ...runners,
        ...nodeAdapters,
        "@effect/platform-bun",
        "@smthrs/platform-bun",
        "@opentelemetry/sdk-trace-node",
        ...telemetryAdapters.slice(0, 3)
      ],
      imports: ["@smthrs/observability/BrowserOtel", "@smthrs/platform-browser"]
    },
    {
      name: "bun",
      dependencies: {
        "@smthrs/platform-bun": firstParty,
        "@smthrs/platform-node": firstParty,
        "@effect/platform-bun": effect,
        "@effect/platform-node": effect,
        "@effect/platform-node-shared": effect,
        effect
      },
      // 8c69f33c moved the native lifecycle into the selected Node host.
      // Its SQLite driver and shared runtime are part of that host's install.
      required: ["@effect/sql-sqlite-node", "@smthrs/flows"],
      absent: [...runners, ...telemetryAdapters, "@smthrs/platform-browser"],
      imports: ["@smthrs/platform-bun", "@smthrs/platform-bun/BunFileSystem", "@smthrs/platform-bun/BunHost"]
    },
  ]
}

export const migrationProfiles = (entries) => {
  const firstParty = candidateVersion(entries)
  return [
    {
      name: "migrate-scan",
      dependencies: {
        "@smthrs/migrate": firstParty,
        "@effect/platform-node": effect,
        "@effect/platform-node-shared": effect,
        effect,
        ["@typescript/typescript-" + process.platform + "-" + process.arch]: "7.0.2"
      },
      omitOptional: true,
      absent: [
        ...runners,
        ...telemetryAdapters,
        ...browserAdapters,
        "@smthrs/agent",
        "@smthrs/engine",
        "@smthrs/harness",
        "@smthrs/registry",
        "@smthrs/flows",
        "@effect/sql-sqlite-node"
      ],
      imports: ["@smthrs/migrate", "@smthrs/migrate/Inventory"]
    },
    {
      name: "migrate-apply",
      dependencies: {
        "@smthrs/migrate": firstParty,
        "@effect/platform-node": effect,
        "@effect/platform-node-shared": effect,
        effect
      },
      required: ["@smthrs/agent", "@smthrs/engine", "@smthrs/harness", "@smthrs/registry", "@smthrs/platform-node", "@smthrs/flows", "@effect/sql-sqlite-node"],
      absent: [...runners, ...telemetryAdapters, ...browserAdapters],
      imports: ["@smthrs/migrate/flow/Command", "@smthrs/migrate/flow/MigrateFlow", "@smthrs/migrate/flow/Layers"]
    }
  ]
}

/**
 * A profile moved onto another Effect release: the application's own `effect`
 * and every Effect adapter it selects, which it picks at the same version. The
 * adapters a Smithers package installs for itself stay where its manifest puts
 * them.
 */
export const onEffect = (profile, version, label = version) => ({
  ...profile,
  name: profile.name + "-effect-" + label,
  // The installed program is the same one; only the Effect under it moved.
  probe: profile.probe ?? profile.name,
  effect: version,
  dependencies: Object.fromEntries(
    Object.entries(profile.dependencies).map(([name, spec]) => [name, isEffectFamily(name) ? version : spec])
  )
})

/**
 * The version the registry serves as `effect@latest` now. `--prefer-online`
 * revalidates the cached metadata, so a release published an hour ago counts.
 * It runs outside the workspace, where a consumer's own install reads the same
 * registry configuration, and it reads stdout alone: npm prints its notices on
 * stderr.
 */
export const latestEffectVersion = async ({ env = process.env } = {}) => {
  const { stdout } = await promisify(execFile)(
    "npm",
    ["view", "effect", "dist-tags.latest", "--prefer-online"],
    { cwd: tmpdir(), env, encoding: "utf8" }
  )
  const version = stdout.trim()
  assert.equal(valid(version), version, "npm view effect dist-tags.latest did not answer one version: " + stdout)
  return version
}

/** Only walk package directories and their nested modules; symlinks are not copies. */
export const physicalPackages = (consumer) => {
  const packages = []
  const modules = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (entry.name === ".pnpm") {
        for (const store of readdirSync(path, { withFileTypes: true })) {
          if (store.isDirectory() && store.name !== "node_modules") modules(join(path, store.name, "node_modules"))
        }
      } else if (entry.name.startsWith("@")) {
        modules(path)
      } else if (!entry.name.startsWith(".")) {
        const manifestPath = join(path, "package.json")
        if (existsSync(manifestPath)) {
          packages.push({ manifest: JSON.parse(readFileSync(manifestPath, "utf8")), path: realpathSync(manifestPath) })
        }
        modules(join(path, "node_modules"))
      }
    }
  }
  modules(join(consumer, "node_modules"))
  return packages
}

/**
 * One physical Effect, inside the supported range, that every installed Effect
 * adapter accepts. This is what an application on any supported release must
 * get, so it is all the quickstart and an `effect@latest` profile can assert.
 */
export const assertSupportedEffect = (consumer, label) => {
  const copies = physicalPackages(consumer).filter(({ manifest }) => manifest.name === "effect")
  assert.equal(copies.length, 1, label + ": expected exactly one physical Effect copy")
  const version = copies[0].manifest.version
  assert.equal(
    satisfies(version, SUPPORTED_EFFECT_RANGE),
    true,
    label + ": installed effect@" + version + " is outside the supported range " + SUPPORTED_EFFECT_RANGE
  )
  return { version, copies, family: assertEffectFamilyAccepts(consumer, version) }
}

export const assertConsumerTree = (consumer, profile) => {
  const installed = physicalPackages(consumer)
  const { copies, version, family: accepting } = assertSupportedEffect(consumer, profile.name)
  // A pinned profile also holds every Effect package to the tested release. A
  // profile moved onto another release holds the application's Effect to it.
  const family = profile.effect === undefined ? assertEffectFamilyInstalled(consumer, effect) : accepting
  assert.equal(version, profile.effect ?? effect, profile.name + ": installed another Effect release")
  const names = new Set(installed.map(({ manifest }) => manifest.name))
  for (const name of profile.absent ?? []) {
    assert.equal(names.has(name), false, profile.name + ": unrelated " + name + " installed")
  }
  for (const name of [...Object.keys(profile.dependencies), ...(profile.required ?? [])]) {
    assert.equal(names.has(name), true, profile.name + ": missing selected dependency " + name)
  }
  const resolutions = []
  for (const { manifest, path } of installed) {
    if (manifest.name !== "effect" && !manifest.name.startsWith("@smthrs/") && !manifest.name.startsWith("@effect/")) {
      continue
    }
    if (manifest.name !== "effect" && !manifest.dependencies?.effect && !manifest.peerDependencies?.effect) continue
    const selected = realpathSync(createRequire(path).resolve("effect/package.json"))
    assert.equal(selected, copies[0].path, manifest.name + ": Effect resolution differs")
    assert.equal(relative(realpathSync(consumer), selected).startsWith(".."), false, "resolution escaped consumer")
    resolutions.push({ name: manifest.name, path, effect: selected })
  }
  assert.ok(resolutions.length > 0)
  return { count: installed.length, effectFamily: family, effectCopies: copies.map(({ path }) => path), resolutions }
}

/** Record actual exit status and exact command, including expected install refusals. */
export const consumerCommand = (command, args, cwd, options = {}) =>
  new Promise((resolveRun, reject) => {
    const started = Date.now()
    console.log(JSON.stringify({ command, args, cwd, event: "start", at: new Date(started).toISOString() }))
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      output += chunk
    })
    child.once("error", reject)
    child.once("close", (exit, signal) => {
      console.log(
        JSON.stringify({
          command,
          args,
          cwd,
          node: process.version,
          event: "end",
          at: new Date().toISOString(),
          exit,
          signal,
          durationMs: Date.now() - started
        })
      )
      if (
        exit !== 0 || command.endsWith("/vitest") || args[0] === "--version" || args.includes("--reporter=append-only")
      ) console.log(output)
      resolveRun({ exit, signal, output })
    })
  })

const successful = async (command, args, cwd, options) => {
  const result = await consumerCommand(command, args, cwd, options)
  assert.equal(result.exit, 0, command + " " + args.join(" ") + "\n" + result.output)
  return result
}

/** CLI alone, with fresh third-party resolution under each supported package manager. */
export const runCliMcpConsumer = async (manager, registryUrl, cliVersion, { env = process.env } = {}) => {
  assert.ok(manager === "npm" || manager === "pnpm", "Unsupported release package manager: " + manager)
  const consumer = await mkdtemp(join(tmpdir(), "smthrs-release-mcp-" + manager + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify(
        {
          private: true,
          packageManager: releasePackageManager,
          dependencies: { "@smthrs/cli": cliVersion }
        },
        null,
        2
      ) + "\n"
    )
    const managerVersion = (await successful(manager, ["--version"], consumer)).output.trim()
    const flags = manager === "npm"
      ? ["--no-audit", "--no-fund", "--cache", join(consumer, ".empty-npm-cache")]
      : [
        "--store-dir",
        join(consumer, ".empty-pnpm-store"),
        "--cache-dir",
        join(consumer, ".empty-pnpm-cache"),
        "--package-import-method=hardlink",
        "--reporter=append-only"
      ]
    await successful(manager, ["install", "--ignore-scripts", ...flags], consumer)
    const tree = assertConsumerTree(consumer, {
      name: "cli-only-" + manager,
      dependencies: { "@smthrs/cli": cliVersion },
      absent: ["@effect/platform-node", "@effect/platform-node-shared", "@effect/platform-bun"]
    })
    const serverInfo = await mcpInitialize(join(consumer, "node_modules/.bin/smthrs"), ["--mcp"], {
      cwd: consumer,
      env: { ...env, HOME: consumer, XDG_CONFIG_HOME: consumer, XDG_DATA_HOME: consumer }
    })
    assert.equal(serverInfo.version, cliVersion, "installed MCP version differs from candidate")
    // Follow the public CLI type through its internal composition to registry
    // metadata. A stale sibling declaration or an erased `any` must fail here.
    const body = [
      "const accountPool = NodeControl.accountPoolDefaultModel",
      "const snapshot = (engine: NodeControl.EngineDurable): ReadonlyArray<string> =>",
      "  engine.host.catalog?.executables.map(({ descriptor }) => {",
      "    const input = descriptor.input",
      "    // @ts-expect-error Nested declarations must retain actual fields rather than any.",
      "    void descriptor.missingConsumerField",
      "    return input?._tag === \"Module\" ? JSON.stringify(input.document ?? null) : descriptor.name",
      "  }) ?? []",
      "void accountPool; void snapshot",
      ""
    ].join("\n")
    await writeFile(
      join(consumer, "cli-consumer.mts"),
      "import * as NodeControl from \"@smthrs/cli/NodeControl\"\n" + body
    )
    await writeFile(
      join(consumer, "cli-consumer.cts"),
      "import NodeControl = require(\"@smthrs/cli/NodeControl\")\n" + body
    )
    const requireCli = createRequire(realpathSync(join(consumer, "node_modules/@smthrs/cli/package.json")))
    const compiler = requireCli.resolve("typescript/bin/tsc")
    const nodeTypesPath = createRequire(requireCli.resolve("@types/ws/package.json")).resolve(
      "@types/node/package.json"
    )
    const nodeTypesManifest = await readFile(nodeTypesPath)
    const nodeTypes = {
      path: nodeTypesPath,
      version: JSON.parse(nodeTypesManifest).version,
      manifestSha256: createHash("sha256").update(nodeTypesManifest).digest("hex"),
      indexSha256: createHash("sha256").update(await readFile(join(dirname(nodeTypesPath), "index.d.ts"))).digest("hex")
    }
    // Match the Node >=26 runtime contract, including require(ESM). Select the
    // Node ambient types from the actual published dependency graph so npm's
    // unrelated hoisted @types packages cannot define the consumer environment.
    for (const module of ["Node20", "NodeNext"]) {
      await successful(process.execPath, [
        compiler,
        "--noEmit",
        "--strict",
        "--module",
        module,
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "--typeRoots",
        dirname(dirname(nodeTypesPath)),
        "--target",
        "ES2022",
        "cli-consumer.mts",
        "cli-consumer.cts"
      ], consumer)
    }
    return { manager, managerVersion, serverInfo, tree, nodeTypes, declarations: ["ESM", "CJS", "Node20", "NodeNext"] }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

export const runConsumerProfile = async (profile, manager, registryUrl, { runtime = false } = {}) => {
  const consumer = await mkdtemp(join(tmpdir(), "smithers-k-consumer-" + manager + "-" + profile.name + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "dependency-profile",
        version: "1.0.0",
        private: true,
        type: "module",
        smthrsReleaseConsumer: true,
        packageManager: releasePackageManager,
        dependencies: profile.dependencies
      })
    )
    const managerVersion = (await successful(manager, ["--version"], consumer)).output.trim()
    const args = [
      "install",
      "--ignore-scripts",
      // A release the registry published today is not in yesterday's metadata.
      ...consumerCacheFlags(manager, repoRoot, { offline: profile.effect === undefined }),
      ...(manager === "npm" ? ["--no-audit", "--no-fund", "--strict-peer-deps"] : ["--strict-peer-dependencies"])
    ]
    if (profile.omitOptional) args.push(manager === "npm" ? "--omit=optional" : "--no-optional")
    await successful(manager, args, consumer)
    const tree = assertConsumerTree(consumer, profile)
    if (runtime) {
      await writeFile(join(consumer, "dependency-resolutions.json"), JSON.stringify(tree.resolutions))
      for (const mode of ["esm", "cjs"]) {
        const source = mode === "esm"
          ? "for (const name of " + JSON.stringify(profile.imports) + ") await import(name)"
          : "for (const name of " + JSON.stringify(profile.imports) + ") require(name)"
        await successful(
          process.execPath,
          [...(mode === "esm" ? ["--input-type=module"] : []), "--eval", source],
          consumer
        )
      }
      const fixture = join(installedConsumerDirectory, "dependency-adapters.mjs")
      await writeFile(
        join(consumer, "consumer-boundary.mjs"),
        await readFile(join(installedConsumerDirectory, "consumer-boundary.mjs"))
      )
      await writeFile(join(consumer, "dependency-adapters.mjs"), await readFile(fixture))
      const probe = profile.probe ?? profile.name
      await successful(process.execPath, ["dependency-adapters.mjs", probe], consumer)
      if (probe === "browser") {
        await bundle({
          absWorkingDir: consumer,
          bundle: true,
          platform: "browser",
          write: false,
          logLevel: "silent",
          stdin: {
            contents:
              "import * as BrowserOtel from \"@smthrs/observability/BrowserOtel\"; globalThis.adapter = BrowserOtel",
            resolveDir: consumer
          }
        })
      }
      if (probe === "bun") await successful("bun", ["dependency-adapters.mjs", probe], consumer)
    }
    console.log(
      "consumer ok " + manager + " " + profile.name + ": " + tree.count + " packages; one Effect, " +
        (profile.effect ?? effect) + "; " + (profile.absent?.length ?? 0) + " absent adapters"
    )
    return { manager, managerVersion, profile: profile.name, ...tree }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

/**
 * The published Flows quickstart as a stranger meets it: the commands of its
 * set-up block, the `pnpm add` line it gives pnpm 11 instead of the npm one,
 * the program its `ts` blocks paste together, the command that runs it and the
 * line it prints. Read from the page, never restated here, so the page and the
 * gate cannot disagree.
 */
export const readQuickstart = (root = repoRoot) => {
  const source = readFileSync(join(root, "packages/smithers/flows/docs/quickstart.md"), "utf8")
  const fenced = (language) =>
    [...source.matchAll(new RegExp("^```" + language + "\\n([\\s\\S]*?)^```$", "gm"))].map(([, body]) => body.trimEnd())
  const [setup, run, ...extra] = fenced("bash")
  const printed = fenced("text")
  assert.ok(setup !== undefined && run !== undefined && extra.length === 0, "quickstart needs a set-up block and a run block")
  assert.equal(printed.length, 1, "quickstart must show the one line the program prints")
  const [enter, ...commands] = setup.split("\n")
  assert.match(enter, /^mkdir (\S+) && cd \1$/, "quickstart must start in a new, empty directory")
  const installs = commands.filter((command) => command.startsWith("npm install "))
  assert.equal(installs.length, 1, "quickstart must give exactly one install line")
  const approvals = [...source.matchAll(/`pnpm approve-builds ([^`]+)`/g)]
  assert.equal(approvals.length, 1, "quickstart must name the one pnpm approve-builds command")
  const pnpmAdds = [...source.matchAll(/`pnpm add ([^`]+)`/g)]
  assert.equal(pnpmAdds.length, 1, "quickstart must give the one pnpm add line")
  return {
    commands,
    install: installs[0],
    packages: installs[0].split(" ").slice(2),
    pnpmPackages: pnpmAdds[0][1].split(/\s+/),
    approveBuilds: approvals[0][1].split(" "),
    program: fenced("ts").join("\n\n") + "\n",
    run: run.split(" "),
    printed: printed[0]
  }
}

/**
 * Package names pnpm reports under "Ignored build scripts", without versions.
 * pnpm 11 ends an install with `ERR_PNPM_IGNORED_BUILDS` and pnpm 10 warns;
 * both print the same list.
 */
export const pnpmIgnoredBuilds = (output) => {
  const line = /Ignored build scripts: ([^\n]+)/.exec(output)?.[1] ?? ""
  return line.split(",").map((entry) => entry.trim().replace(/\.$/, "")).filter(Boolean)
    .map((entry) => entry.replace(/@[^@]+$/, "")).sort()
}

/** Package names a program imports, without its relative and `node:` specifiers. */
export const importedPackages = (program) => [
  ...new Set(
    [...program.matchAll(/\bfrom\s+"([^"./][^"]*)"/g)]
      .map(([, specifier]) => specifier)
      .filter((specifier) => !specifier.startsWith("node:"))
      .map((specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/"))
  )
].sort()

/**
 * `PATH` without the entries that hold an executable `jj`. The quickstart never
 * calls `Jj`, so it must run on a machine that never installed jj (#3894).
 */
export const pathWithoutJj = (path = "") =>
  path.split(delimiter).filter((entry) => {
    if (entry === "") return false
    try {
      accessSync(join(entry, "jj"), constants.X_OK)
      return !statSync(join(entry, "jj")).isFile()
    } catch {
      return true
    }
  }).join(delimiter)

/**
 * The install line plus the pasted quickstart, from an empty directory (#3838).
 * Nothing is preinstalled: the project declares exactly what the install line
 * names, so a package the program reaches only through an optional peer fails
 * here the way it fails for a stranger. The line names `effect` without a
 * version, so the install reads fresh registry metadata and gets the Effect a
 * stranger gets today, `effect@latest` (#3839); the project must then hold one
 * physical Effect inside the supported range. The second run proves the replay the
 * page promises by changing the file the first run read. `env` is the smoke's
 * CLI environment: a final pack runs on its own packaged native helper, and a
 * pre-helper rehearsal on the configured source helper. `latestEffect`, when
 * given, is the release npm calls latest: an npm install must get exactly it.
 * pnpm 11 holds a release younger than its `minimumReleaseAge`, so a pnpm
 * install is held to the range only and reports what it got. The program runs
 * with jj removed from `PATH` and no `SMITHERS_JJ_PATH`.
 */
export const runQuickstartConsumer = async (
  manager,
  registryUrl,
  { quickstart = readQuickstart(), env = process.env, latestEffect } = {}
) => {
  assert.ok(manager === "npm" || manager === "pnpm", "Unsupported release package manager: " + manager)
  const consumer = await mkdtemp(join(tmpdir(), "smthrs-release-quickstart-" + manager + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    const managerVersion = (await successful(manager, ["--version"], consumer)).output.trim()
    // The page gives pnpm its own `pnpm add` line: pnpm 11 holds a tag's newest
    // release back for 24 hours, so the line names the exact version.
    const packages = manager === "npm" ? quickstart.packages : quickstart.pnpmPackages
    const installed = [manager, manager === "npm" ? "install" : "add", ...packages]
    for (const command of quickstart.commands) {
      if (command !== quickstart.install) {
        await successful("sh", ["-c", command], consumer)
        continue
      }
      if (manager === "npm") {
        await successful(manager, [
          ...installed.slice(1),
          "--ignore-scripts",
          ...consumerCacheFlags(manager, repoRoot, { offline: false }),
          "--no-audit",
          "--no-fund"
        ], consumer)
        continue
      }
      // pnpm runs as the page says: `pnpm add`, then `pnpm approve-builds` for
      // exactly the packages pnpm held back. A new dependency with an install
      // script fails here until the page names it.
      await successful("npm", ["pkg", "set", "packageManager=" + releasePackageManager], consumer)
      const flags = consumerCacheFlags(manager, repoRoot, { offline: false })
      const added = await consumerCommand(manager, [...installed.slice(1), ...flags], consumer)
      const ignored = pnpmIgnoredBuilds(added.output)
      assert.deepEqual(
        ignored,
        ignored.length === 0 ? [] : [...quickstart.approveBuilds].sort(),
        "pnpm held back build scripts the page does not approve:\n" + added.output
      )
      if (ignored.length === 0) {
        assert.equal(added.exit, 0, installed.join(" ") + "\n" + added.output)
        continue
      }
      await successful(manager, ["approve-builds", ...quickstart.approveBuilds], consumer)
      await successful(manager, ["install", ...flags], consumer)
    }
    const declared = Object.keys(JSON.parse(await readFile(join(consumer, "package.json"), "utf8")).dependencies).sort()
    const named = packages.map(specName).sort()
    assert.deepEqual(declared, named, "the project declares exactly the packages on the install line")
    const { version: effectVersion } = assertSupportedEffect(consumer, manager + " quickstart")
    if (manager === "npm" && latestEffect !== undefined) {
      assert.equal(effectVersion, latestEffect, "npm quickstart installed effect@" + effectVersion + ", not latest " + latestEffect)
    }
    await writeFile(join(consumer, "quickstart.ts"), quickstart.program)
    const [command, ...args] = quickstart.run
    assert.equal(command, "node", "the quickstart runs under node")
    const runs = []
    const withoutJj = { ...env, PATH: pathWithoutJj(env.PATH) }
    delete withoutJj.SMITHERS_JJ_PATH
    for (const attempt of ["first run", "second run"]) {
      const result = await captureProcess(process.execPath, args, consumer, { timeoutMs: 120_000, env: withoutJj })
      assert.equal(result.ok, true, manager + " quickstart " + attempt + " failed:\n" + result.output)
      assert.equal(result.output.trim(), quickstart.printed, manager + " quickstart " + attempt + " printed something else")
      runs.push(result.output.trim())
      // A replayed step answers from the journal, so the next run must not see this.
      await writeFile(join(consumer, "workspace/note.txt"), "changed after the " + attempt + "\n")
    }
    console.log(
      "quickstart ok " + manager + " " + managerVersion + ": " + installed.join(" ") + "; one Effect, " + effectVersion +
        "; printed and replayed"
    )
    return { manager, managerVersion, install: installed.join(" "), declared, effect: effectVersion, runs }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

/**
 * An application on an Effect outside the supported range is told so at
 * install time. The refused version is the last release candidate, which is
 * what a project that followed the earlier exact pin still declares.
 */
export const refuseUnsupportedEffect = async (manager, registryUrl, entries) => {
  const firstParty = candidateVersion(entries)
  const consumer = await mkdtemp(join(tmpdir(), "smithers-k-unsupported-effect-" + manager + "-"))
  try {
    await writeFile(join(consumer, ".npmrc"), "@smthrs:registry=" + registryUrl + "\n")
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: releasePackageManager,
        dependencies: { "@smthrs/database": firstParty, effect: UNSUPPORTED_EFFECT_VERSION }
      })
    )
    await successful(manager, ["--version"], consumer)
    const result = await consumerCommand(manager, [
      "install",
      "--ignore-scripts",
      ...consumerCacheFlags(manager),
      ...(manager === "npm" ? ["--strict-peer-deps", "--no-audit", "--no-fund"] : ["--strict-peer-dependencies"])
    ], consumer)
    assert.notEqual(result.exit, 0, "effect@" + UNSUPPORTED_EFFECT_VERSION + " must be refused")
    assert.equal(result.signal, null)
    assert.match(result.output, manager === "npm" ? /ERESOLVE/ : /ERR_PNPM_PEER_DEP_ISSUES/)
    assert.match(result.output, literally(SUPPORTED_EFFECT_RANGE))
    assert.match(result.output, literally(UNSUPPORTED_EFFECT_VERSION))
    return { manager, exit: result.exit, effect: UNSUPPORTED_EFFECT_VERSION, range: SUPPORTED_EFFECT_RANGE }
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

export const runConsumerMatrix = async (directory, entries, {
  profiles = minimalProfiles(entries),
  managers = ["npm", "pnpm"],
  runtime = false,
  // The published quickstart runs wherever the candidate's code does.
  quickstart = runtime,
  env = process.env
} = {}) => {
  const registry = await releaseRegistry(directory, entries)
  const results = []
  const failures = []
  try {
    // The Node profile is the application that picks its own Effect adapters,
    // so it is the one that also runs on `effect@latest` as the registry
    // serves it now (#3839). Today's release is read once for both managers.
    const node = profiles.find((profile) => profile.name === "node")
    const latestEffect = node === undefined && !quickstart ? undefined : await latestEffectVersion()
    const latest = node === undefined ? [] : [onEffect(node, latestEffect, "latest")]
    for (const manager of managers) {
      for (const profile of [...profiles, ...latest]) {
        try {
          results.push(await runConsumerProfile(profile, manager, registry.url, { runtime }))
        } catch (cause) {
          const error = new Error(manager + " " + profile.name + ": " + cause.message, { cause })
          failures.push(error)
          console.error(error.message)
        }
      }
      try {
        results.push({ unsupported: await refuseUnsupportedEffect(manager, registry.url, entries) })
      } catch (cause) {
        const error = new Error(manager + " unsupported Effect: " + cause.message, { cause })
        failures.push(error)
        console.error(error.message)
      }
      if (quickstart) {
        try {
          results.push({ quickstart: await runQuickstartConsumer(manager, registry.url, { env, latestEffect }) })
        } catch (cause) {
          const error = new Error(manager + " quickstart: " + cause.message, { cause })
          failures.push(error)
          console.error(error.message)
        }
      }
    }
    console.log(JSON.stringify({
      consumerMatrix: {
        profilesPassed: results.filter((result) => result.profile !== undefined).length,
        effectLatest: latest[0]?.effect ?? null,
        unsupportedEffectRefusals: results.filter((result) => result.unsupported !== undefined).length,
        quickstartsPassed: results.filter((result) => result.quickstart !== undefined).length,
        quickstartEffect: [...new Set(results.flatMap((result) => result.quickstart?.effect ?? []))],
        failures: failures.length
      },
      node: process.version
    }))
    if (failures.length) throw new AggregateError(failures, failures.length + " consumer profiles failed")
    return results
  } finally {
    await registry.close()
  }
}

if (isMain(import.meta)) {
  const directory = resolve(process.argv[2])
  const entries = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  await runConsumerMatrix(directory, entries, {
    profiles: [
      ...minimalProfiles(entries),
      ...adapterProfiles(entries),
      ...migrationProfiles(entries),
    ],
    runtime: true
  })
}
