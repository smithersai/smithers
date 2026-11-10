import assert from "node:assert/strict";
import test from "node:test";
import { Project } from "ts-morph";
import { desugarMessageUnions } from "../src/message-union.js";

const source = (text: string) => new Project({ useInMemoryFileSystem: true }).createSourceFile("m.ts", text);

test("a message union becomes a `_tag` union with a typed match, on the same lines", () => {
  const original = [
    "export const Message = defineMessageUnion({",
    "  Reset: {},",
    "  Set: { n: Schema.Number, by: Schema.optionalKey(Schema.Array(Size)), kind: Schema.Literals([\"a\", \"b\"]) },",
    "})",
    "export type Message = typeof Message.Type",
    "function f(m: typeof Message.Type): number { return 1 }",
  ].join("\n");
  const file = source(original);
  assert.deepEqual(desugarMessageUnions(file), ["Message"]);
  const text = file.getFullText();
  assert.equal(text.split("\n").length, original.split("\n").length);
  assert.match(text.split("\n")[0]!, /^export type Message = \{ readonly _tag: "Reset" \} \| \{ readonly _tag: "Set"; readonly n: number; readonly by\?: ReadonlyArray<Size>; readonly kind: "a" \| "b" \}; export declare const Message: \{ match<R>/);
  assert.match(text, /Set: \(message: \{ readonly n: number; readonly by\?: ReadonlyArray<Size>; readonly kind: "a" \| "b" \}\) => R/);
  assert.equal(text.split("\n")[5], "function f(m: Message): number { return 1 }");
  const members = file.getFunctionOrThrow("f").getParameters()[0]!.getType().getUnionTypes();
  assert.deepEqual(members.map(m => m.getProperty("_tag")!.getTypeAtLocation(file).getLiteralValue()), ["Reset", "Set"]);
});

test("a payload field LemmaScript cannot type is refused by name", () => {
  const file = source("const M = defineMessageUnion({ Moved: { at: Schema.DateTimeUtc } })");
  assert.throws(() => desugarMessageUnions(file), /m\.ts:1: M\.Moved\.at: Schema\.DateTimeUtc is not read/);
});

test("a file without a message union is left alone", () => {
  const file = source("const x = 1\n");
  assert.deepEqual(desugarMessageUnions(file), []);
  assert.equal(file.getFullText(), "const x = 1\n");
});
