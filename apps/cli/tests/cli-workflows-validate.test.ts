import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWorkflows,
  validateWorkflowName,
  resolveWorkflow,
  createWorkflowFile,
} from "../src/workflows";

const TMP = join(tmpdir(), `smithers-workflows-test-${Date.now()}`);
const WORKFLOWS_DIR = join(TMP, ".smithers", "workflows");

beforeAll(() => {
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  writeFileSync(
    join(WORKFLOWS_DIR, "hello-world.tsx"),
    [
      "// smithers-source: seeded",
      "// smithers-display-name: Hello World",
      "export default () => null;",
    ].join("\n"),
  );
  writeFileSync(
    join(WORKFLOWS_DIR, "deploy.tsx"),
    "export default () => null;\n",
  );
  writeFileSync(
    join(WORKFLOWS_DIR, "not-tsx.js"),
    "export default () => null;\n",
  );
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("discoverWorkflows", () => {
  test("discovers .tsx files in .smithers/workflows", () => {
    const workflows = discoverWorkflows(TMP);
    const ids = workflows.map((w) => w.id);
    expect(ids).toContain("hello-world");
    expect(ids).toContain("deploy");
  });

  test("ignores non-.tsx files", () => {
    const workflows = discoverWorkflows(TMP);
    const ids = workflows.map((w) => w.id);
    expect(ids).not.toContain("not-tsx");
  });

  test("sorts by id", () => {
    const workflows = discoverWorkflows(TMP);
    const ids = workflows.map((w) => w.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("parses source type from comment", () => {
    const workflows = discoverWorkflows(TMP);
    const hello = workflows.find((w) => w.id === "hello-world")!;
    expect(hello.sourceType).toBe("seeded");
  });

  test("parses display name from comment", () => {
    const workflows = discoverWorkflows(TMP);
    const hello = workflows.find((w) => w.id === "hello-world")!;
    expect(hello.displayName).toBe("Hello World");
  });

  test("defaults source type to user", () => {
    const workflows = discoverWorkflows(TMP);
    const deploy = workflows.find((w) => w.id === "deploy")!;
    expect(deploy.sourceType).toBe("user");
  });

  test("defaults display name to id", () => {
    const workflows = discoverWorkflows(TMP);
    const deploy = workflows.find((w) => w.id === "deploy")!;
    expect(deploy.displayName).toBe("deploy");
  });

  test("returns empty array when directory does not exist", () => {
    const workflows = discoverWorkflows("/tmp/nonexistent-smithers-dir");
    expect(workflows).toEqual([]);
  });
});

describe("validateWorkflowName", () => {
  test("accepts valid lowercase-hyphen names", () => {
    expect(() => validateWorkflowName("hello-world")).not.toThrow();
    expect(() => validateWorkflowName("deploy")).not.toThrow();
    expect(() => validateWorkflowName("my-workflow-123")).not.toThrow();
  });

  test("rejects uppercase", () => {
    expect(() => validateWorkflowName("HelloWorld")).toThrow(/Invalid workflow name/);
  });

  test("rejects underscores", () => {
    expect(() => validateWorkflowName("hello_world")).toThrow(/Invalid workflow name/);
  });

  test("rejects spaces", () => {
    expect(() => validateWorkflowName("hello world")).toThrow(/Invalid workflow name/);
  });

  test("rejects leading hyphen", () => {
    expect(() => validateWorkflowName("-hello")).toThrow(/Invalid workflow name/);
  });

  test("rejects trailing hyphen", () => {
    expect(() => validateWorkflowName("hello-")).toThrow(/Invalid workflow name/);
  });

  test("rejects empty string", () => {
    expect(() => validateWorkflowName("")).toThrow(/Invalid workflow name/);
  });
});

describe("resolveWorkflow", () => {
  test("resolves existing workflow", () => {
    const workflow = resolveWorkflow("hello-world", TMP);
    expect(workflow.id).toBe("hello-world");
    expect(workflow.entryFile).toContain("hello-world.tsx");
  });

  test("throws for nonexistent workflow", () => {
    expect(() => resolveWorkflow("nonexistent", TMP)).toThrow(
      /Workflow not found/,
    );
  });
});

describe("createWorkflowFile", () => {
  test("creates workflow file with expected content", () => {
    const createDir = join(TMP, "create-test");
    mkdirSync(createDir, { recursive: true });
    try {
      const result = createWorkflowFile("my-feature", createDir);
      expect(result.id).toBe("my-feature");
      expect(result.sourceType).toBe("generated");
      expect(existsSync(result.path)).toBe(true);
    } finally {
      rmSync(createDir, { recursive: true, force: true });
    }
  });

  test("throws for invalid workflow name", () => {
    expect(() => createWorkflowFile("Invalid_Name", TMP)).toThrow();
  });

  test("throws if workflow already exists", () => {
    expect(() => createWorkflowFile("hello-world", TMP)).toThrow(
      /already exists/,
    );
  });
});
