/** Rebuild the real archived designs and preserve their last good page when an input is absent. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("./", import.meta.url));
for (const [design, argv, inputs] of [
  ["media", ["sh", "build.sh"], ["build.sh", "extra.css", "body.html"]],
  ["desktop", [process.execPath, "build.mjs"], ["build.mjs", "template.html"]],
]) {
  function fixture(t) {
    const folder = mkdtempSync(join(tmpdir(), "design-build-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const cwd = join(folder, design);
    mkdirSync(cwd);
    for (const input of [...inputs, "index.html"]) cpSync(join(root, design, input), join(cwd, input));
    // Missing checked-in inputs remain missing: this must also catch an incomplete source checkout.
    if (readdirSync(root).includes("refs")) cpSync(join(root, "refs"), join(folder, "refs"), { recursive: true });
    return { folder, cwd };
  }

  test(`${design} rebuild reproduces the committed page from checked-in inputs`, (t) => {
    const { cwd } = fixture(t);
    const expected = readFileSync(join(cwd, "index.html"));
    rmSync(join(cwd, "index.html"));
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(join(cwd, "index.html")).equals(expected), "page bytes must remain identical");
    }
    assert.deepEqual(readdirSync(cwd).sort(), [...inputs, "index.html"].sort());
  });

  for (const missing of ["../refs/live-app.css", ...inputs.slice(1)]) {
    test(`${design} preserves index.html when ${missing} is missing`, (t) => {
      const { cwd } = fixture(t);
      const expected = readFileSync(join(cwd, "index.html"));
      rmSync(join(cwd, missing), { force: true });
      const files = readdirSync(cwd);
      const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.ok(readFileSync(join(cwd, "index.html")).equals(expected), "page bytes must remain identical");
      assert.deepEqual(readdirSync(cwd), files);
    });
  }
}
