import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

// SHA-256 of the exact GitHub blob bytes, not a reserialized JSON object.
// Refresh deliberately alongside the source revision documented in the README.
test("the vendored VibeLang grammar matches pinned upstream commit 3ad97368", async () => {
  const source = await Bun.file(new URL("../src/grammars/VibeLang.tmLanguage.json", import.meta.url)).arrayBuffer();
  expect(createHash("sha256").update(new Uint8Array(source)).digest("hex")).toBe(
    "a9d0e7e47b043ac90372d54d5e7146ff8ccb1352d1c7a611bc586ecec5e26d73",
  );
});
