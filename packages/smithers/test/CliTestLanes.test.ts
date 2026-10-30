import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, it } from "vitest"

const cwd = join(import.meta.dirname, "..")
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const list = (args: Array<string>): Array<string> => {
  // `vitest list --filesOnly` omits sharding. Use the runner's discovery and
  // configured sequencer, exactly as its execution pool selects files.
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { createVitest, parseCLI } from "vitest/node";
const { filter, options } = parseCLI(["vitest", ...JSON.parse(process.argv[1])]);
const { registerRootCleanup } = await import("../repo-targets/test-utils/vitest-root-temp.mjs");
const ctx = await createVitest("test", { ...options, run: true, coverage: { enabled: false } });
try {
  registerRootCleanup(ctx);
  const files = await ctx.globTestSpecifications(filter);
  const selected = ctx.config.shard ? await new ctx.config.sequence.sequencer(ctx).shard(files) : files;
  console.log(JSON.stringify(selected.map((file) => file.moduleId)));
} finally { await ctx.close(); }`,
    JSON.stringify(args)
  ], { cwd, encoding: "utf8", timeout: 15_000 })
  return JSON.parse(output) as Array<string>
}

const declaredShell = () =>
  JSON.parse(execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import { Package } from \"./PACKAGE.ts\"; import { metadata } from \"@smthrs/targets/Target\"; console.log(JSON.stringify(metadata(Package.test).attrs.shell))"
  ], { cwd, encoding: "utf8", timeout: 15_000 })) as string

it("schedules every CLI test file once without leaving the remainder on one worker", () => {
  // Read the declared target, then ask the real runner what each invocation selects.
  const shell = declaredShell()
  const commands = [...shell.matchAll(/pnpm exec vitest run ([^;"&}]+)/g)]
    .map((match) => match[1]!.trim().split(/\s+/))
    .filter((args) => !args.some((arg) => arg.startsWith("--merge-reports=")))
    .map((args) => args.filter((arg) => !/^--(?:outputFile|reporter|coverage\.)/.test(arg)))
  // A CLI `--exclude` replaces the config's exclude list, as it does for the
  // remainder shards, so the full selection is taken the same way.
  const all = list(["--exclude", "**/node_modules/**"])
  const selections = commands.map(list)
  expect(selections.flat().sort()).toEqual(all.sort())
  expect(Math.max(...selections.map((files) => files.length))).toBeLessThanOrEqual(Math.ceil(all.length / 4))
})

it.skipIf(process.platform === "win32")(
  "starts another shard while earlier groups are blocked, then merges all results",
  () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-cli-lanes-"))
    try {
      symlinkSync(join(cwd, "node_modules"), join(root, "node_modules"), "dir")
      writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}")
      writeFileSync(
        join(root, "vitest.config.mjs"),
        "export default { test: { include: [\"*.test.mjs\"], testTimeout: 12000, coverage: { enabled: false } } }"
      )
      const shell = declaredShell()
        .replace("cd packages/smithers && ", "")
        .replace("&& trap", "&& printf '%s' \"$work\" > \"$SMITHERS_LANES_SCRATCH_RECEIPT\" && trap")
        .replaceAll("vitest.config.ts", "vitest.config.mjs")
        .replace(/pnpm exec vitest run ([^;"&}]+)/g, (command, args: string) => {
          if (args.includes("--merge-reports=")) return command
          const phase = /--outputFile=\$blobs\/([a-z-]+)\.json/.exec(args)![1]!
          // Real Vitest processes: the first three wait for the second remainder
          // shard. A fixed handoff leaves that shard behind a blocked group.
          writeFileSync(
            join(root, `${phase}.test.mjs`),
            `
import { it, expect } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { temporaryEnvironment } from ${JSON.stringify(new URL("./temporaryEnvironment.ts", import.meta.url).href)};
it(${JSON.stringify(phase)}, async () => {
  expect(process.env.VIBELANG_CACHE_DIR).toEqual(expect.any(String));
  const isolatedCache = execFileSync(process.execPath, ["-e", "process.stdout.write(process.env.VIBELANG_CACHE_DIR ?? '')"], {
    env: temporaryEnvironment(), encoding: "utf8"
  });
  expect(isolatedCache).toBe(process.env.VIBELANG_CACHE_DIR);
  writeFileSync(${JSON.stringify(join(root, phase))}, process.env.VIBELANG_CACHE_DIR);
  if (${phase.endsWith("-fixed")}) {
    const deadline = Date.now() + 8000;
    while (!existsSync(${JSON.stringify(join(root, "two"))}) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(${JSON.stringify(join(root, "two"))})).toBe(true);
  }
});`
          )
          return `pnpm exec vitest run --config vitest.config.mjs --reporter=blob --outputFile=$blobs/${phase}.json ${phase}.test.mjs `
        })
        // pnpm's relative bin shims resolve from the temporary symlink on a
        // clean CI install. Run the same installed Vitest through its real
        // entrypoint so the fixture tests lane scheduling across installs.
        .replaceAll("pnpm exec vitest", `${quote(process.execPath)} ${quote(vitest)}`)
      const scratch = join(root, "tmp")
      mkdirSync(scratch)
      execFileSync("sh", ["-c", shell], {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          SMITHERS_LANES_SCRATCH_RECEIPT: join(root, "owned-work")
        },
        encoding: "utf8",
        timeout: 25_000
      })
      const owned = readFileSync(join(root, "owned-work"), "utf8")
      for (const phase of ["one-fixed", "two-fixed", "three-fixed", "one", "two", "three", "four"]) {
        expect(readFileSync(join(root, phase), "utf8")).toBe(join(owned, "vibelang-cache"))
      }
      expect(readdirSync(scratch)).toEqual([])
      expect(existsSync(owned)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
