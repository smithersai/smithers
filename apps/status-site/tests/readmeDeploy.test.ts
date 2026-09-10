import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * The Deploy section is what a maintainer types. It must not put a Cloudflare
 * token on an interactive command line (shell history keeps it), and it must
 * not send readers to sibling directories that no longer exist.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploySection = readme.slice(readme.indexOf("## Deploy"));
const appsDir = new URL("../../", import.meta.url);

describe("README deploy section", () => {
  test("never inlines CLOUDFLARE_API_TOKEN on a command line", () => {
    expect(deploySection).not.toMatch(/CLOUDFLARE_API_TOKEN=/);
  });

  test("points only at directories that exist", () => {
    expect(deploySection).not.toContain("apps/*-site");
    const siblings = readdirSync(appsDir).filter((name) => name.endsWith("-site"));
    expect(siblings).toEqual(["status-site"]);
    for (const match of deploySection.matchAll(/`(apps\/[^`]+)`/g)) {
      expect(existsSync(new URL(`../../../${match[1]}`, import.meta.url))).toBe(true);
    }
  });
});
