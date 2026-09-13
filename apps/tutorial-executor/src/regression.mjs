import { test } from "node:test"
import assert from "node:assert/strict"
import { greet } from "/workspace/repo/src/hello.ts"
test("missing name receives world", () => assert.equal(greet(null), "Hello, world!"))
test("empty name receives world", () => assert.equal(greet(""), "Hello, world!"))
test("provided name is preserved", () => assert.equal(greet("Ada"), "Hello, Ada!"))
