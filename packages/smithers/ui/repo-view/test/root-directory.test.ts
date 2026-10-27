import { expect, test } from "bun:test";
import { directoryEntries } from "../src/paths";

test("the root sentinel is never its own directory entry", () => {
  expect(directoryEntries(["a.md"], "", ["", "empty"])).toEqual([
    { name: "empty", path: "empty", kind: "directory" },
    { name: "a.md", path: "a.md", kind: "file" },
  ]);
  expect(directoryEntries([], "", [""])).toEqual([]);
});
