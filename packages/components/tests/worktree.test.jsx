/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { WORKTREE_EMPTY_PATH_ERROR } from "@smithers-orchestrator/graph/constants";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { Parallel, Sequence, Task, Worktree, Workflow, } from "../src/components/index.js";
import { outputSchemas } from "./schema.js";
describe("<Worktree>", () => {
    test("attaches worktreeId/worktreePath to nested tasks", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="w">
        <Worktree id="wt" path="./subdir">
          <Task id="t" output={outputSchemas.outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>, { baseRootDir: "." });
        const t = res.tasks[0];
        expect(t.worktreeId).toBe("wt");
        expect(typeof t.worktreePath).toBe("string");
        expect(t.worktreePath && t.worktreePath.length > 0).toBe(true);
    });
    test("skipIf prevents subtree extraction", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="w">
        <Worktree path="./x" skipIf>
          <Task id="t" output={outputSchemas.outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>, { baseRootDir: "." });
        expect(res.tasks.length).toBe(0);
    });
    test("duplicate Worktree id throws", async () => {
        const renderer = new SmithersRenderer();
        await expect(renderer.render(<Workflow name="w">
          <Sequence>
            <Worktree id="dup" path="./a">
              <Task id="a" output={outputSchemas.outputA}>
                {{ value: 1 }}
              </Task>
            </Worktree>
            <Worktree id="dup" path="./b">
              <Task id="b" output={outputSchemas.outputA}>
                {{ value: 2 }}
              </Task>
            </Worktree>
          </Sequence>
        </Workflow>, { baseRootDir: "." })).rejects.toThrow();
    });
    test("empty path throws early in component", () => {
        // Invoke component directly to validate props before rendering machinery
        expect(() => Worktree({ path: "   ", children: null })).toThrow(WORKTREE_EMPTY_PATH_ERROR);
    });
    test("empty path throws early in component (empty string)", () => {
        expect(() => Worktree({ path: "", children: null })).toThrow(WORKTREE_EMPTY_PATH_ERROR);
    });
    test("missing path throws early in component (undefined)", () => {
        expect(() => Worktree({ path: undefined, children: null })).toThrow(WORKTREE_EMPTY_PATH_ERROR);
    });
    test("skipIf does not bypass path validation", () => {
        // Even when skipIf is true, invalid path should throw immediately
        expect(() => Worktree({ path: "   ", skipIf: true, children: null })).toThrow(WORKTREE_EMPTY_PATH_ERROR);
    });
    test("resolves relative path against baseRootDir", async () => {
        const renderer = new SmithersRenderer();
        const base = process.cwd();
        const rel = "sub/wt";
        const res = await renderer.render(<Workflow name="w">
        <Worktree id="r" path={rel}>
          <Task id="rt" output={outputSchemas.outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>, { baseRootDir: base });
        const t = res.tasks[0];
        const expected = require("node:path").resolve(base, rel);
        expect(t.worktreePath).toBe(expected);
    });
    test("absolute path is preserved", async () => {
        const renderer = new SmithersRenderer();
        const abs = require("node:path").resolve("/", "tmp", "smithers-wt-abs");
        const res = await renderer.render(<Workflow name="w">
        <Worktree id="abs" path={abs}>
          <Task id="at" output={outputSchemas.outputA}>
            {{ value: 1 }}
          </Task>
        </Worktree>
      </Workflow>, { baseRootDir: "/does/not/matter" });
        const t = res.tasks[0];
        expect(t.worktreePath).toBe(abs);
    });
    test("nested worktrees prefer innermost path", async () => {
        const renderer = new SmithersRenderer();
        const base = process.cwd();
        const outer = "outer-wt";
        const inner = "inner-wt";
        const res = await renderer.render(<Workflow name="w">
        <Worktree id="outer" path={outer}>
          <Worktree id="inner" path={inner}>
            <Task id="t" output={outputSchemas.outputA}>
              {{ value: 1 }}
            </Task>
          </Worktree>
        </Worktree>
      </Workflow>, { baseRootDir: base });
        const t = res.tasks[0];
        const expectedInner = require("node:path").resolve(base, inner);
        expect(t.worktreeId).toBe("inner");
        expect(t.worktreePath).toBe(expectedInner);
    });
    test("tasks outside Worktree do not get worktree fields", async () => {
        const renderer = new SmithersRenderer();
        const res = await renderer.render(<Workflow name="w">
        <Task id="t" output={outputSchemas.outputA}>
          {{ value: 1 }}
        </Task>
      </Workflow>, { baseRootDir: "." });
        expect(res.tasks[0].worktreeId).toBeUndefined();
        expect(res.tasks[0].worktreePath).toBeUndefined();
    });
});
