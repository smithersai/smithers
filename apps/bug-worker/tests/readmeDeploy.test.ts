import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Deployment instructions separate local plans from qualified publication.
 * Secrets never go on a command line, where shell history keeps them.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const deploySection = readme.slice(readme.indexOf("## Deploy"));

describe("README deploy section", () => {
  test("only documents non-publishing plan commands", () => {
    const commands = [...deploySection.matchAll(/^```sh\n([\s\S]*?)^```/gm)]
      .flatMap((block) => block[1]!.trim().split("\n"));
    expect(commands).toEqual([
      "pnpm -C apps/bug-worker run plan --adopt",
      "pnpm -C apps/bug-worker run plan",
    ]);
  });

  test("directs publication to the qualified Cloud rollout requirements", () => {
    expect(deploySection).toContain("qualified Cloud rollout");
    expect(deploySection).toMatch(/\[[^\]]+\]\(docs\/deployment\.md\)/);
    expect(deploySection).toMatch(/refuses\s+publication/);
  });

  test("never inlines a secret on a command line", () => {
    expect(deploySection).not.toMatch(/(CLOUDFLARE_API_TOKEN|ALCHEMY_PASSWORD|BUG_ADMIN_TOKEN|RESEND_API_KEY|GITHUB_FORK_TOKEN)=/);
  });
});
