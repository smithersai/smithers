import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * `wrangler.jsonc` and `alchemy.run.ts` are two spellings of one deployment, so
 * a setting changed in one and not the other ships a Worker nobody described.
 * The `$schema` line is the only one an editor resolves for completion, and
 * pnpm's isolated layout keeps wrangler under this package rather than under
 * the repository root, so a path that walks out of the package resolves to
 * nothing and the config is edited unvalidated.
 */
const configSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const config = JSON.parse(configSource.replace(/^\s*\/\/.*$/gm, "")) as {
  $schema: string;
  assets: { run_worker_first: boolean | string[] };
};
const alchemySource = readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8");
const withoutSpace = (value: string) => value.replace(/\s+/g, "");

describe("wrangler.jsonc", () => {
  test("$schema names the installed wrangler schema", () => {
    expect(config.$schema).not.toStartWith("../");
    expect(existsSync(new URL(`../${config.$schema}`, import.meta.url))).toBe(true);
  });

  test("alchemy.run.ts mirrors run_worker_first", () => {
    const mirrored = /runWorkerFirst:\s*(.+?),?\n/.exec(alchemySource)?.[1];
    expect(mirrored).toBeTruthy();
    expect(withoutSpace(mirrored as string)).toBe(withoutSpace(JSON.stringify(config.assets.run_worker_first)));
  });
});
