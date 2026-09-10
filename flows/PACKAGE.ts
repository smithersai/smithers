/** Repository flows, release workflows, and the retained migration fixtures. */
import { Smithers } from "@smthrs/targets"

const pack = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/pack.test.mjs")]),
  srcs: [
    Smithers.glob("//flows/**/flow.mdx"),
    Smithers.glob("//flows/**/flow.ts"),
    Smithers.file("//.smithers/factory.json"),
    Smithers.file("//.smithers/home.json")
  ],
  deps: []
})

const cwd = "flows"
const sources = Smithers.glob("//flows/**/*.ts")
const scripts = Smithers.glob("//scripts/*.mjs")

const check = Smithers.Typecheck({
  srcs: [sources, scripts], deps: [], tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false, incremental: false, cwd
})
const suite = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//flows/test/content.test.ts"),
    Smithers.file("//flows/test/publication.test.ts"),
    Smithers.file("//flows/test/workflows.test.ts")
  ]),
  srcs: [sources, scripts, Smithers.file("//pnpm-workspace.yaml")], deps: [], cwd
})

const recording = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/recording.test.ts")]),
  srcs: [sources], deps: [], cwd
})
const provider = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/provider-runtime.test.ts")]),
  srcs: [sources], deps: [], cwd
})

// Source-only dependencies keep the backend graph reactive without building
// every backend package before an uncached coding test. The inventory is checked
// against pnpm workspace membership; each glob retains its owning package boundary.
const codingPackages = [
  "packages/smithers",
  "packages/smithers/agent",
  "packages/smithers/agent/chain",
  "packages/smithers/agent/evals",
  "packages/smithers/agent/fs",
  "packages/smithers/agent/harness",
  "packages/smithers/agent/integrations",
  "packages/smithers/agent/memory",
  "packages/smithers/agent/model",
  "packages/smithers/agent/plugin",
  "packages/smithers/agent/registry",
  "packages/smithers/agent/scorers",
  "packages/smithers/agent/std",
  "packages/smithers/agent/triggers",
  "packages/smithers/build",
  "packages/smithers/build/build-cli",
  "packages/smithers/build/infra",
  "packages/smithers/build/targets",
  "packages/smithers/control",
  "packages/smithers/create-app",
  "packages/smithers/flows",
  "packages/smithers/flows/artifacts",
  "packages/smithers/flows/canonical",
  "packages/smithers/flows/capability",
  "packages/smithers/flows/core",
  "packages/smithers/flows/crypto",
  "packages/smithers/flows/database",
  "packages/smithers/flows/engine",
  "packages/smithers/flows/engine-store",
  "packages/smithers/flows/flow",
  "packages/smithers/flows/jj",
  "packages/smithers/flows/journal",
  "packages/smithers/flows/kernel",
  "packages/smithers/flows/keys",
  "packages/smithers/flows/observability",
  "packages/smithers/flows/patterns",
  "packages/smithers/flows/plan",
  "packages/smithers/flows/platform-browser",
  "packages/smithers/flows/platform-bun",
  "packages/smithers/flows/platform-node",
  "packages/smithers/flows/run-store",
  "packages/smithers/flows/sandbox",
  "packages/smithers/flows/step-cache",
  "packages/smithers/flows/sync",
  "packages/smithers/flows/time-travel",
  "packages/smithers/gateway",
  "packages/smithers/mcp",
  "packages/smithers/migrate",
  "packages/smithers/notifications",
  "packages/smithers/ui",
  "packages/smithers/ui/ui-styleguide"
] as const
const codingBackend = codingPackages.map(cwd => Smithers.Filegroup({ cwd,
  srcs: [Smithers.glob("src/**"), Smithers.file("package.json"), Smithers.file("tsconfig.json")]
}))
const codingScripts = Smithers.Filegroup({ cwd: "scripts", srcs: [Smithers.glob("*.mjs")] })
const codingSources = [sources, Smithers.glob("//flows/**/*.mjs"), Smithers.glob("//flows/coding/**/*.md"),
  Smithers.pnpmWorkspace("//pnpm-workspace.yaml"),
  Smithers.file("//pnpm-lock.yaml"), Smithers.file("//flows/tsconfig.json")]
const codingDependencies = [...codingBackend, codingScripts]
const node = Smithers.Runtime.Node({ version: ">=22.19.0" })
const bun = Smithers.Runtime.Bun({ version: ">=1.4.0" })

// Existing policy integration uses actual JJ and the Node SQLite fixture.
const coding = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([Smithers.file("//flows/test/coding.test.ts")]),
  srcs: codingSources, deps: codingDependencies, cwd
})
const codingPolicy = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([Smithers.file("//flows/test/coding-host.test.ts"), Smithers.file("//flows/test/coding-gates.test.ts")]),
  srcs: codingSources, deps: codingDependencies, cwd
})
const codingRuntime = Smithers.NodeTest({
  runtime: node,
  runner: Smithers.testRunner([Smithers.file("//flows/test/coding-planning-authority.test.ts"), Smithers.file("//flows/test/coding-project-config.test.ts"),
    Smithers.file("//flows/test/coding-steering.test.ts"), Smithers.file("//flows/test/coding-request-coordinator.test.ts")]),
  srcs: codingSources, deps: codingDependencies, cwd
})
const codingConfigBun = Smithers.NodeTest({
  runtime: bun,
  runner: Smithers.testRunner([Smithers.file("//flows/test/coding-project-config.test.ts")]),
  srcs: codingSources, deps: codingDependencies, cwd
})

// Explicit slow gates: preflight refuses missing native tools instead of letting
// opt-in integration cases silently skip. The existing Shell.Test is uncached.
const codingNative = Smithers.Shell.Test({ bin: Smithers.Runtime.bin, runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "source"], data: [...codingSources, ...codingDependencies], timeout: "45m" })
const codingNativeBun = Smithers.Shell.Test({ bin: Smithers.Runtime.bin, runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "source"], data: [...codingSources, ...codingDependencies], timeout: "45m" })
const codingBundle = Smithers.Shell.Test({ bin: Smithers.Runtime.bin, runtime: node,
  args: ["flows/test/coding-native-gate.mjs", "bundle"], data: [...codingSources, ...codingDependencies], timeout: "45m" })
const codingBundleBun = Smithers.Shell.Test({ bin: Smithers.Runtime.bin, runtime: bun,
  args: ["flows/test/coding-native-gate.mjs", "bundle"], data: [...codingSources, ...codingDependencies], timeout: "45m" })
const wiki = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//flows/test/wiki.test.ts")]),
  srcs: [sources, Smithers.file("//factory/wiki/catalog.ts")], deps: [], cwd
})

export const Package = Smithers.Package({ targets: { coding, codingPolicy, codingRuntime, codingConfigBun,
  codingNative, codingNativeBun, codingBundle, codingBundleBun, pack, check, suite, recording, provider, wiki } })
