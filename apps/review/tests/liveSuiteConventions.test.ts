import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ghBin } from "../src/github/runGh.ts";
import { ghCredentialsAvailable, liveSuiteGate } from "./support/liveSuite.ts";

/**
 * Two conventions that a reader cannot check by running the suite, because
 * both failures look like success: a live suite that skips without saying so
 * reads as a pass, and a second place that decides which `gh` to spawn agrees
 * with the first until the day it does not.
 */

const appDir = fileURLToPath(new URL("../", import.meta.url));
const RUN_GH = join(appDir, "src/github/runGh.ts");

/** Every TypeScript file this app owns, source and test alike. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") || path.endsWith(".mjs")) found.push(path);
    }
  };
  for (const top of ["src", "action/src", "tests", "bin"]) walk(join(appDir, top));
  return found;
}

describe("a live suite that skips says why", () => {
  test("credentials alone never enable a live GitHub suite", () => {
    const names = ["GITHUB_TOKEN", "SMITHERS_GH_BIN", "SMITHERS_REVIEW_E2E"] as const;
    const saved = names.map((name) => process.env[name]);
    try {
      process.env.GITHUB_TOKEN = "fixture-token";
      process.env.SMITHERS_GH_BIN = join(appDir, "tests/action/fixtures/fake-gh");
      delete process.env.SMITHERS_REVIEW_E2E;
      expect(ghCredentialsAvailable()).toBe(false);
      process.env.SMITHERS_REVIEW_E2E = "1";
      expect(ghCredentialsAvailable()).toBe(true);
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  test("the gate returns the flag and stays quiet when the suite runs", () => {
    const lines: string[] = [];
    expect(liveSuiteGate({ tag: "t", enabled: true, reason: "unused", log: (l) => lines.push(l) })).toBe(true);
    expect(lines).toEqual([]);
  });

  test("the gate names the suite and the reason on exactly one line when it skips", () => {
    const lines: string[] = [];
    expect(liveSuiteGate({ tag: "review e2e", enabled: false, reason: "no token", log: (l) => lines.push(l) })).toBe(
      false,
    );
    expect(lines).toEqual(["[review e2e] skipped: no token"]);
  });

  test("every live suite in this app goes through the gate", () => {
    const e2e = sourceFiles().filter((path) => path.endsWith(".e2e.test.ts"));
    expect(e2e.length).toBeGreaterThan(0);
    const silent = e2e.filter((path) => !readFileSync(path, "utf8").includes("liveSuiteGate("));
    expect(silent.map((path) => relative(appDir, path))).toEqual([]);
  });
});

describe("the gh binary is chosen in one place", () => {
  test("ghBin defaults to gh and honors SMITHERS_GH_BIN", () => {
    const saved = process.env.SMITHERS_GH_BIN;
    try {
      delete process.env.SMITHERS_GH_BIN;
      expect(ghBin()).toBe("gh");
      process.env.SMITHERS_GH_BIN = "/opt/fake/gh";
      expect(ghBin()).toBe("/opt/fake/gh");
    } finally {
      if (saved === undefined) delete process.env.SMITHERS_GH_BIN;
      else process.env.SMITHERS_GH_BIN = saved;
    }
  });

  test("nothing spawns a literal gh, so the override reaches every call", () => {
    const literal = /(execFile|execFileSync|spawn|spawnSync)\(\s*"gh"/;
    const offenders = sourceFiles().filter((path) => literal.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => relative(appDir, path))).toEqual([]);
  });

  test("only runGh.ts reads the override, so no preflight can check a different binary", () => {
    const read = /process\.env\.SMITHERS_GH_BIN\s*(\|\||\?\?)/;
    const offenders = sourceFiles().filter((path) => path !== RUN_GH && read.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => relative(appDir, path))).toEqual([]);
  });
});
