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

// Where the suite's Zig keeps its global cache: the build's cache directory, which a confined run may write.
const zigGlobalCache = "{smthrs:cache-directory}/tools/zig/global"

// Zig fills an empty global cache once, in about 200 s under load, before it does anything else; then it answers in
// under a second. The suite waits for this fill instead of paying it inside a test's two-minute limit.
const zigCache = Smithers.Shell.Build({
  shell:
    "command -v zig > /dev/null || exit 0; cd \"$(mktemp -d)\" && zig build --print-configuration > /dev/null 2>&1; true",
  env: { ZIG_GLOBAL_CACHE_DIR: zigGlobalCache },
  cache: false,
  sandbox: "none"
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
    "test/fixtures/closure-zig/**",
    // test/replay runs keyring.py in the jail and smithers.sh as the replay's smthrs.
    "test/**/*.py",
    "test/**/*.sh"
  ],
  // The suite starts real builds. On a build server at load 100 to 220 it passed the default 20 minutes every time.
  testTimeoutMs: 2_400_000,
  // test/closure/zig builds with Zig; test/replay traces runs with strace and jails them with bubblewrap; the
  // decompose, cli and tools tests run npm; test/cache serves the cache with Bun; test/package starts bunx.
  testTools: ["zig", "strace", "bwrap", "npm", "bun", "bunx"].map((name) => Smithers.Host.bin(name)),
  // Zig compiles a build runner into its global cache. A confined run is shown no cache of the host's, so without one
  // of its own every test that starts `zig build` compiled it again and passed its time limit under load.
  testEnv: { ZIG_GLOBAL_CACHE_DIR: zigGlobalCache },
  testDeps: [zigCache],
  cwd
})

// The wall-time benchmarks, test/**/*.benchmark.test.ts. Each holds a time against another time of the same run, so
// the machine's load decides it as much as the code does. The target is exclusive: `smthrs ci "//..."` leaves it out,
// its label runs it, and it runs alone, after every other target of the run has ended.
const bench = Smithers.Vitest({
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
  targets: { bench, cacheModule, check, circular, docs, docsFiles, fmt, lib, lint, test, zigCache, ...sources }
})
