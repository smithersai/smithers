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

// test/docs.test.ts checks that every page a docs page links to exists; two are Smithers build's.
const linkedDocs = Smithers.Filegroup({
  srcs: [Smithers.file("docs/README.md"), Smithers.file("docs/workspace/remote-caching.md")],
  cwd: "packages/smithers/build"
})

// The suite's tools keep their caches in the build's cache directory, which a confined run may write: a confined run is
// shown none of the host's, and each is addressed by the content of what it built, so it changes no verdict.
const toolCacheEnv = {
  ZIG_GLOBAL_CACHE_DIR: "{smthrs:cache-directory}/tools/zig/global",
  VIBELANG_CACHE_DIR: "{smthrs:cache-directory}/tools/vibelang",
  NODE_COMPILE_CACHE: "{smthrs:cache-directory}/tools/node-compile-cache",
  DPRINT_CACHE_DIR: "{smthrs:cache-directory}/tools/dprint"
}

// Filled before the suite starts, never inside a test's time limit. Zig fills an empty global cache once, in about
// 200 s under load, before it does anything else; the programs the suite starts as processes (smithers-ci and smthrs)
// compile their sources once; dprint fetches the plugins this package's configuration pins, which test/tools formats
// with and a confined run cannot download. Then each answers in under a second.
const toolCaches = Smithers.Shell.Build({
  shell: [
    "if command -v zig > /dev/null; then (cd \"$(mktemp -d)\" && zig build --print-configuration > /dev/null 2>&1); fi",
    "node packages/ci/bin/smithers-ci.mjs --help > /dev/null 2>&1",
    "node_modules/.bin/smthrs --help > /dev/null 2>&1",
    "(cd packages/ci && node_modules/.bin/dprint output-file-paths > /dev/null 2>&1)",
    "true"
  ].join("; "),
  env: toolCacheEnv,
  cache: false,
  sandbox: "none"
})

const { bench, check, circular, docs, docsFiles, fmt, lib, lint, test, testParts } = BuildAndCheckTypeScriptPackage({
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
    "test/fixtures/closure-zig/**",
    // test/replay runs keyring.py in the jail and smithers.sh as the replay's smthrs.
    "test/**/*.py",
    "test/**/*.sh",
    // test/tools formats with this package's own dprint configuration.
    "dprint.json",
    // docs/README.md links this package's README, and test/docs.test.ts checks that it exists.
    "README.md",
    // Each part's configuration builds on the whole suite's.
    "vitest.config.ts",
    // What a part says of a source it falls short on.
    "vitest.shortfall.ts"
  ],
  // Together the cases run past a CI job's hour on a GitHub runner (over 48 minutes on ubuntu and macOS, run
  // 44901780543), so the suite runs as four parts, each in a job of its own. `test` names all four.
  testParts: {
    testCli: { config: Smithers.file("vitest.part-cli.config.ts") },
    testReplay: { config: Smithers.file("vitest.part-replay.config.ts") },
    testNative: { config: Smithers.file("vitest.part-native.config.ts") },
    testRest: { config: Smithers.file("vitest.part-rest.config.ts") }
  },
  // The suite starts real builds. On a build server at load 100 to 220 it passed the default 20 minutes every time,
  // and 40 minutes run as the workspace declares it. Run confined, the run whose result is stored, it is shown none of
  // the host's compile caches and twice ran past 40 minutes under quiet-run on nyc-01 (2,597 s and 2,569 s in all).
  testTimeoutMs: 3_600_000,
  // test/closure/zig builds with Zig; test/replay traces runs with strace and jails them with bubblewrap; the
  // decompose, cli and tools tests run npm; test/cache serves the cache with Bun; test/package starts bunx.
  testTools: ["zig", "strace", "bwrap", "npm", "bun", "bunx"].map((name) => Smithers.Host.bin(name)),
  // Zig compiles a build runner into its global cache. A confined run is shown no cache of the host's, so without one
  // of its own every test that starts `zig build` compiled it again and passed its time limit under load.
  testEnv: toolCacheEnv,
  // smithers-ci runs on Linux and macOS (docs/getting-started/quickstart.md), so its suite does too: on Windows the
  // package suites leave it out, as a person on Windows cannot run the program it tests.
  testHosts: ["linux", "darwin"],
  testDeps: [toolCaches, linkedDocs],
  cwd
})

// The wall-time benchmarks, test/**/*.benchmark.test.ts. Each holds a time against another time of the same run, so
// the machine's load decides it as much as the code does. The target is exclusive: `smthrs ci "//..."` leaves it out,
// its label runs it, and it runs alone, after every other target of the run has ended.
const benchHeavy = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.benchmark.test.ts")],
  sources: [
    Smithers.glob("src/**/*.{ts,vibe}"),
    Smithers.glob("test/**/*.{ts,vibe}"),
    Smithers.file("tsconfig.json"),
    Smithers.file("tsconfig.test.json"),
    Smithers.file("//packages/repo-targets/test-utils/test-process-environment.mjs"),
    Smithers.glob("bin/*.mjs"),
    Smithers.glob("test/**/*.mjs"),
    Smithers.glob("test/**/*.sh"),
    Smithers.glob("test/fixtures/*.json")
  ],
  deps: [lib, ...Object.values(sources), cacheModule],
  config: Smithers.file("vitest.benchmark.config.ts"),
  environment: "node",
  coverage: false,
  exclusive: true,
  passWithNoTests: false,
  timeoutMs: 2_400_000,
  tools: ["strace", "bwrap", "npm"].map((name) => Smithers.Host.bin(name)),
  cwd
})

export const Package = Smithers.Package({
  targets: {
    bench,
    benchHeavy,
    cacheModule,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    test,
    ...testParts,
    linkedDocs,
    toolCaches,
    ...sources
  }
})
