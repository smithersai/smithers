import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectivePath } from "../../src/git/effectivePath.ts";
import { loadDiffs } from "../../src/git/loadDiffs.ts";
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts";
import { tempRepos } from "../support/tempRepos.ts";

const { git, write, track, initRepo } = tempRepos();

describe("loadDiffs", () => {
  test("workspace mode renders untracked symlinks as their target, never the linked file", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    // A readable file outside the repository, reachable only through a link.
    const outside = mkdtempSync(join(tmpdir(), "ocr-outside-"));
    track(outside);
    const secretPath = join(outside, "credentials.txt");
    writeFileSync(secretPath, "DUMMY_SECRET_OUTSIDE_REPO\n");
    symlinkSync(secretPath, join(dir, "src/leak.ts"));
    symlinkSync(join(outside, "absent.txt"), join(dir, "src/broken.ts"));
    symlinkSync(outside, join(dir, "src/linkdir.ts"));
    write(join(dir, "src/plain.ts"), "export const plain = 1;\n");

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir });
    const whole = diffs.map((d) => d.diff).join("\n");
    expect(whole).not.toContain("DUMMY_SECRET_OUTSIDE_REPO");

    const leak = diffs.find((d) => effectivePath(d) === "src/leak.ts");
    expect(leak?.diff).toContain("new file mode 120000");
    expect(leak?.diff).toContain(`+${secretPath}`);
    // A dangling link still renders; it must not throw or read anything.
    const broken = diffs.find((d) => effectivePath(d) === "src/broken.ts");
    expect(broken?.diff).toContain("new file mode 120000");
    expect(broken?.diff).toContain(`+${join(outside, "absent.txt")}`);
    // A link to a directory is not walked into.
    const linkDir = diffs.find((d) => effectivePath(d) === "src/linkdir.ts");
    expect(linkDir?.diff).toContain("new file mode 120000");
    // Ordinary untracked files still contribute their contents.
    const plain = diffs.find((d) => effectivePath(d) === "src/plain.ts");
    expect(plain?.diff).toContain("+export const plain = 1;");
    expect(plain?.diff).not.toContain("new file mode 120000");
  });
});
