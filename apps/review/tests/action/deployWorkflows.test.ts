import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * The two deployment workflows this lane owns, and the rulings that hold them.
 *
 * They live in this suite because `.github/workflows/{apps-deploy,canary}.yml`
 * ship with `apps/review` under one owner and this is that owner's only test
 * runner. `apps/server/scripts/canary/workflow-wiring.test.ts` grades a
 * different property, that every probe has a caller, and neither file
 * asserts the other's.
 */
const workflowsDir = fileURLToPath(new URL("../../../../.github/workflows/", import.meta.url));
const appsDir = fileURLToPath(new URL("../../../", import.meta.url));

const readWorkflow = <T>(name: string): T => parse(readFileSync(`${workflowsDir}${name}`, "utf8")) as T;

describe("canary.yml stays inert until deployment ownership moves", () => {
  test("the repository guard names smithersai/flows, so the schedule never fires here", () => {
    // The deployed Worker at canary.smithers.sh and its hourly job are not an
    // rc.0 validation surface. The guard is what keeps the job from
    // starting: flipped to this repository it would run hourly against a
    // deployment this repository does not yet own, and its alert step files a
    // GitHub issue on every failure.
    //
    // Re-enabling the canary is a deliberate act after ownership moves: change this
    // line, and this test with it.
    const canary = readWorkflow<{ jobs: Record<string, { if?: string }> }>("canary.yml");
    expect(canary.jobs.probe.if).toBe("github.repository == 'smithersai/flows'");
  });
});

describe("apps-deploy.yml names apps this workspace still has", () => {
  /**
   * The `name` -> declared scripts of every manifest the deploy may gate on:
   * the apps, plus the contract package they share (`@smthrs/rpc`, which
   * moved from `apps/shared` to `packages/rpc` and still guards the deploy).
   */
  function appScripts(): Map<string, Set<string>> {
    const apps = new Map<string, Set<string>>();
    const roots = [appsDir, fileURLToPath(new URL("../../../../packages/", import.meta.url))];
    for (const root of roots) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let manifest: { name?: string; scripts?: Record<string, string> };
        try {
          manifest = JSON.parse(readFileSync(`${root}${entry.name}/package.json`, "utf8"));
        } catch {
          continue; // Not a package directory.
        }
        if (manifest.name) apps.set(manifest.name, new Set(Object.keys(manifest.scripts ?? {})));
      }
    }
    return apps;
  }

  /** Every `<app>:<script>` pair the workflow's gate loops run. */
  function gatedPairs(): string[] {
    const text = readFileSync(`${workflowsDir}apps-deploy.yml`, "utf8");
    const pairs: string[] = [];
    for (const [, apps, script] of text.matchAll(/for app in ([^\n;]+); do\s*\n\s+pnpm --filter "\$app" run (\S+)/g)) {
      for (const app of apps.trim().split(/\s+/)) pairs.push(`${app}:${script}`);
    }
    return pairs;
  }

  test("every app the deploy gates on exists and declares the script it runs", () => {
    // The rename pass gave four apps `@smthrs/` names. `pnpm --filter` on a
    // name nothing matches is a no-op that exits 0, so a stale filter here
    // would let the deploy skip the gate it believes it ran and ship anyway.
    const pairs = gatedPairs();
    // The exact roster, not a floor: a floor let the gate silently shrink when
    // apps left the tree, and it read as "eight or more" long after only three
    // remained. Dropping or adding a gated app is a decision this line records.
    expect(pairs).toEqual([
      "smithers-app:typecheck",
      "smithers-server:typecheck",
      "@smthrs/rpc:typecheck",
      "smithers-app:test",
      "smithers-server:test",
      "@smthrs/rpc:test"
    ]);
    const apps = appScripts();
    const broken = pairs.filter((pair) => {
      const [name, script] = pair.split(":");
      return !apps.get(name!)?.has(script!);
    });
    expect(broken).toEqual([]);
  });

  test("the deploy still calls the server app's own deploy scripts", () => {
    const text = readFileSync(`${workflowsDir}apps-deploy.yml`, "utf8");
    const server = appScripts().get("smithers-server");
    expect(server?.has("deploy")).toBe(true);
    expect(server?.has("deploy:dry")).toBe(true);
    expect(text).toContain("pnpm --filter smithers-server run deploy:dry");
    expect(text).toContain("pnpm --filter smithers-server run deploy");
  });
});
