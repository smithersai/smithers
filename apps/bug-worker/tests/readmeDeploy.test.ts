import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The Deploy section is what a maintainer types. Secrets never go on an
 * interactive command line, where shell history keeps them in plaintext.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploySection = readme.slice(readme.indexOf("## Deploy"));

describe("README deploy section", () => {
  test("never inlines a secret on a command line", () => {
    expect(deploySection).not.toMatch(/(CLOUDFLARE_API_TOKEN|ALCHEMY_PASSWORD|BUG_ADMIN_TOKEN)=/);
  });
});
