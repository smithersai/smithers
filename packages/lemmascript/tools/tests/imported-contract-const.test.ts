import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { equal } from "../fixtures/imported-contract-const-cross-collision/use.ts";

test("two copied contracts cannot conflate different constants named LIMIT", () => {
  assert.equal(equal(), false);
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL(
    "../fixtures/imported-contract-const-cross-collision/use.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "fixture must be valid TypeScript");
  assert.throws(() => extractModule(source), /imported const 'LIMIT'.*collides/);
});
