import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { extractModule } from "../src/extract.js";

const fixture = (path: string) => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));

function extracted(dir: string, file: string) {
  const project = new Project({ tsConfigFilePath: fixture(`${dir}/tsconfig.json`) });
  return extractModule(project.addSourceFileAtPath(fixture(`${dir}/${file}`)));
}

test("an anonymous schema type is the named type of the same structure", () => {
  const module = extracted("structural", "use.ts");
  const names = module.typeDecls.map(d => d.name);
  for (const name of ["Model", "Client", "Pending", "Status", "Last", "Ref"]) assert.ok(names.includes(name), name);
  assert.ok(!names.some(n => /^Model[A-Z]|^LiteralUnion|^TaggedUnion/.test(n)), names.join(", "));
  const model = module.typeDecls.find(d => d.name === "Model")!;
  assert.equal(model.fields!.find(f => f.name === "client")!.tsType, "Client");
  const client = module.typeDecls.find(d => d.name === "Client")!;
  assert.deepEqual(client.fields!.map(f => [f.name, f.tsType]), [["gap", "boolean"], ["status", "Status"], ["pending", "Pending[]"], ["last", "Last"]]);
});

test("a constant declared without a value is kept, as a fixed value of its type, even when only a switch case reads it", () => {
  const module = extracted("structural", "use.ts");
  assert.deepEqual(module.constants.map(c => [c.name, c.tsType, c.value]), [["empty", "Client", null]]);
});
