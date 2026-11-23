import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import { describe, test } from "vitest"
import * as Input from "../src/Input.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as Target from "../src/Target.ts"
import * as VitestBench from "../src/VitestBench.ts"

const opts = { time: 120, warmupTime: 30 }

const workspaceRoot = NodePath.resolve(import.meta.dirname, "../../../../..")
const packageDir = "packages/smithers/build/targets"

const baseManifest = {
  name: "@smthrs/example",
  version: "1.0.0",
  type: "module",
  license: "MIT",
  scripts: {
    test: "vitest run",
    build: "node scripts/build.mjs",
    lint: "eslint src",
    check: "vibelang -p tsconfig.test.json --noEmit"
  },
  dependencies: {
    effect: "4.0.0-beta.43",
    "@smthrs/flow": "workspace:*"
  }
}

const overrideManifest = {
  version: "1.0.1",
  scripts: {
    bench: "vitest bench --run",
    test: "vitest run --coverage.enabled=true"
  },
  devDependencies: {
    vitest: "5.0.0"
  }
}

const SampleRule = Target.make("BenchSampleTarget", {
  attrs: Schema.Struct({
    srcs: Schema.Array(Input.Declared),
    deps: Schema.Array(Target.Target),
    cwd: Schema.NonEmptyString
  }),
  kinds: ["build"],
  success: Schema.Void,
  error: Target.NotImplemented,
  implementation: () => Target.catalogNotImplemented()
})

const sharedWalkCache = Input.makeWalkCache()

describe("@smthrs/targets", () => {
  test("Input.resolvePath, rootRelative, and staticPrefix", async ({ bench }) => {
    const inputs = [
      "src/**/*.ts",
      "//packages/smithers/build/targets/src/Input.ts",
      "test/Targets.bench.ts",
      "docs/reference/*.md"
    ]
    await bench("Input path helpers (4 patterns)", () => {
      for (const pattern of inputs) {
        const resolved = Input.resolvePath(packageDir, pattern)
        Input.rootRelative(packageDir, resolved)
        Input.staticPrefix(pattern)
      }
    }).run(opts)
  })

  test("Input.expandGlob with shared WalkCache", async ({ bench }) => {
    await bench("Input.expandGlob (cached walk)", async () => {
      await Input.expandGlob(workspaceRoot, packageDir, "src/**/*.ts", { walks: sharedWalkCache })
    }).run(opts)
  })

  test("Target.make instantiation + metadata extraction", async ({ bench }) => {
    const srcs = [Input.glob("src/**/*.ts"), Input.file("package.json")]
    await bench("Target instantiate + metadata", () => {
      const target = SampleRule({ srcs, deps: [], cwd: packageDir })
      Target.metadata(target)
    }).run(opts)
  })

  test("PackageJson.merge, render, and diffFields", async ({ bench }) => {
    await bench("PackageJson merge + render + diff", () => {
      const merged = PackageJson.merge(baseManifest, overrideManifest)
      PackageJson.render(merged)
      PackageJson.diffFields(baseManifest, merged)
    }).run(opts)
  })

  test("VitestBench.benchArguments", async ({ bench }) => {
    const attrs = {
      config: Input.file("vitest.config.ts"),
      cwd: packageDir,
      environment: "node",
      passWithNoTests: false
    }
    await bench("VitestBench.benchArguments", () => {
      VitestBench.benchArguments(attrs)
    }).run(opts)
  })
})
