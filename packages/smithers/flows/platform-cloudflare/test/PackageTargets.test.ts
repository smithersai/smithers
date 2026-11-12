/**
 * The package's target graph, read from PACKAGE.ts in a Node child so the
 * build tool's types stay out of this suite's compilation.
 */
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

// Loading the graph compiles the engine's VibeLang sources, about 25 s on a loaded host.
it(
  "runs the suite for docs only through the test target, which packs the sandbox CLI first",
  { timeout: 120_000 },
  () => {
    // ContainerTerminal.workerd.test.ts builds apps/mvp/infra/sandbox, whose Dockerfile copies the cli/ sandboxCli packs.
    const output = execFileSync(process.execPath, [
      "--import",
      "vibelang/register",
      "--input-type=module",
      "--eval",
      `
    import { Package } from "./PACKAGE.ts";
    import { metadata } from "@smthrs/targets/Target";
    const closure = new Set();
    const walk = (target) => {
      if (closure.has(target)) return;
      closure.add(target);
      for (const dependency of metadata(target).dependencies) walk(dependency);
    };
    walk(Package.docs);
    const suites = [...closure].filter((target) => metadata(target).kinds.includes("test"));
    console.log("SUITES " + JSON.stringify(suites.map((suite) => ({
      test: suite === Package.test,
      sandboxCli: metadata(suite).dependencies.includes(Package.sandboxCli)
    }))));
    `
    ], { cwd: packageRoot, encoding: "utf8", timeout: 110_000 })
    expect(JSON.parse(output.split("SUITES ")[1]!)).toEqual([{ test: true, sandboxCli: true }])
  }
)
