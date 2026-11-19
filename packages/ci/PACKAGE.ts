import { BuildAndCheckTypeScriptPackage, WorkspaceSources } from "@smthrs/repo-targets"
/** Standard package targets. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/ci"

// The sources of the workspace packages this one loads: the build, the type-check, the suite and the lint read them.
const sources = WorkspaceSources({ cwd })

// test/cache hosts the cache from the Terraform module's migrations and service, which belong to Smithers build.
const cacheModule = Smithers.Filegroup({
  srcs: [Smithers.glob("terraform/modules/cache/**")],
  cwd: "packages/smithers/build"
})

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  reads: [...Object.values(sources), cacheModule],
  // test/docs.test.ts reads the docs pages and the splash page; test/cli runs bin/ and test/cli/program.mjs;
  // test/closure/zig copies and builds the Zig project under test/fixtures/closure-zig.
  testData: [
    "docs/**/*.md",
    "docs/splash/index.html",
    "bin/*.mjs",
    "test/**/*.mjs",
    "test/fixtures/*.json",
    "test/fixtures/closure-zig/**"
  ],
  // The suite starts real builds. On a build server at load 100 to 220 it passed the default 20 minutes every time.
  testTimeoutMs: 2_400_000,
  // test/closure/zig builds with Zig; test/replay traces runs with strace and jails them with bubblewrap; the
  // decompose, cli and tools tests run npm; test/cache serves the cache with Bun; test/package starts bunx.
  testTools: ["zig", "strace", "bwrap", "npm", "bun", "bunx"].map((name) => Smithers.Host.bin(name)),
  cwd
})

export const Package = Smithers.Package({
  targets: { cacheModule, check, circular, docs, docsFiles, fmt, lib, lint, test, ...sources }
})
