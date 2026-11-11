import assert from "node:assert/strict";
import test from "node:test";
import { Project } from "ts-morph";
import { extractModule } from "../src/extract.js";

test("a tagged match inside an argument keeps its typed arms and evaluates the input once", () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const source = project.createSourceFile("m.ts", `
type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number };
declare const Message: { match<R>(message: Message, handlers: { Reset: () => R; Set: (m: { n: number }) => R }): R };
//@ extern
//@ impure
declare function read(): Message;
//@ verify
//@ ensures true
export function result(): number {
  const next = 1 + Message.match(read(), { Reset: () => 0, Set: ({ n }) => n });
  return next;
}
`);
  const fn = extractModule(source).functions.find(f => f.name === "result")!;
  const encoded = JSON.stringify(fn.body);
  assert.match(encoded, /"discriminant":"_tag"/);
  assert.equal((encoded.match(/"name":"read"/g) ?? []).length, 1);
});
