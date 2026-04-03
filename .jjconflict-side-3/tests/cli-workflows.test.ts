import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkflows,
  resolveWorkflow,
  validateWorkflowName,
  createWorkflowFile,
} from "../src/cli/workflows";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-wf-"));
}

describe("discoverWorkflows", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    dirs.length = 0;
  });

  test("returns empty array when workflows dir missing", () => {
    const root = makeTempDir();
    dirs.push(root);
    const result = discoverWorkflows(root);
    expect(result).toEqual([]);
  });

  test("discovers .tsx files in workflows dir", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "my-workflow.tsx"), "export default {};");
    writeFileSync(join(wfDir, "another.tsx"), "export default {};");

    const result = discoverWorkflows(root);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("another");
    expect(result[1].id).toBe("my-workflow");
  });

  test("ignores non-tsx files", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "workflow.tsx"), "export default {};");
    writeFileSync(join(wfDir, "readme.md"), "# hello");
    writeFileSync(join(wfDir, "config.ts"), "export const x = 1;");

    const result = discoverWorkflows(root);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("workflow");
  });

  test("parses source type from metadata comment", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "test.tsx"),
      "// smithers-source: seeded\nexport default {};",
    );

    const result = discoverWorkflows(root);
    expect(result[0].sourceType).toBe("seeded");
  });

  test("parses display name from metadata comment", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "test.tsx"),
      "// smithers-display-name: My Workflow\nexport default {};",
    );

    const result = discoverWorkflows(root);
    expect(result[0].displayName).toBe("My Workflow");
  });

  test("defaults to id as display name", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "my-workflow.tsx"), "export default {};");

    const result = discoverWorkflows(root);
    expect(result[0].displayName).toBe("my-workflow");
  });

  test("results are sorted by id", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "zebra.tsx"), "");
    writeFileSync(join(wfDir, "alpha.tsx"), "");
    writeFileSync(join(wfDir, "middle.tsx"), "");

    const result = discoverWorkflows(root);
    expect(result.map((w) => w.id)).toEqual(["alpha", "middle", "zebra"]);
  });

  test("parses generated source type", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "gen.tsx"),
      "// smithers-source: generated\nexport default {};",
    );

    const result = discoverWorkflows(root);
    expect(result[0].sourceType).toBe("generated");
  });

  test("defaults source type to user", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "plain.tsx"), "export default {};");

    const result = discoverWorkflows(root);
    expect(result[0].sourceType).toBe("user");
  });

  test("ignores directories inside workflows dir", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    mkdirSync(join(wfDir, "subdir.tsx")); // directory, not file
    writeFileSync(join(wfDir, "real.tsx"), "export default {};");

    const result = discoverWorkflows(root);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("real");
  });
});

describe("resolveWorkflow", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    dirs.length = 0;
  });

  test("resolves existing workflow by id", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "my-wf.tsx"), "export default {};");

    const result = resolveWorkflow("my-wf", root);
    expect(result.id).toBe("my-wf");
    expect(result.entryFile).toContain("my-wf.tsx");
  });

  test("throws for non-existent workflow", () => {
    const root = makeTempDir();
    dirs.push(root);
    expect(() => resolveWorkflow("missing", root)).toThrow(
      "Workflow not found",
    );
  });

  test("throws when workflows dir does not exist", () => {
    const root = makeTempDir();
    dirs.push(root);
    expect(() => resolveWorkflow("any", root)).toThrow("Workflow not found");
  });

  test("resolves workflow with metadata", () => {
    const root = makeTempDir();
    dirs.push(root);
    const wfDir = join(root, ".smithers", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "annotated.tsx"),
      "// smithers-source: seeded\n// smithers-display-name: Annotated Flow\nexport default {};",
    );

    const result = resolveWorkflow("annotated", root);
    expect(result.sourceType).toBe("seeded");
    expect(result.displayName).toBe("Annotated Flow");
  });
});

describe("validateWorkflowName", () => {
  test("accepts valid kebab-case names", () => {
    expect(() => validateWorkflowName("my-workflow")).not.toThrow();
    expect(() => validateWorkflowName("simple")).not.toThrow();
    expect(() => validateWorkflowName("a-b-c")).not.toThrow();
    expect(() => validateWorkflowName("test123")).not.toThrow();
  });

  test("accepts single character name", () => {
    expect(() => validateWorkflowName("a")).not.toThrow();
  });

  test("accepts numbers-only name", () => {
    expect(() => validateWorkflowName("123")).not.toThrow();
  });

  test("rejects uppercase names", () => {
    expect(() => validateWorkflowName("MyWorkflow")).toThrow(
      "Invalid workflow name",
    );
  });

  test("rejects names with underscores", () => {
    expect(() => validateWorkflowName("my_workflow")).toThrow(
      "Invalid workflow name",
    );
  });

  test("rejects names with spaces", () => {
    expect(() => validateWorkflowName("my workflow")).toThrow(
      "Invalid workflow name",
    );
  });

  test("rejects empty string", () => {
    expect(() => validateWorkflowName("")).toThrow("Invalid workflow name");
  });

  test("rejects names starting with hyphen", () => {
    expect(() => validateWorkflowName("-leading")).toThrow(
      "Invalid workflow name",
    );
  });

  test("rejects names ending with hyphen", () => {
    expect(() => validateWorkflowName("trailing-")).toThrow(
      "Invalid workflow name",
    );
  });

  test("rejects consecutive hyphens", () => {
    expect(() => validateWorkflowName("double--hyphen")).toThrow(
      "Invalid workflow name",
    );
  });
});

describe("createWorkflowFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    dirs.length = 0;
  });

  test("creates workflow file in .smithers/workflows", () => {
    const root = makeTempDir();
    dirs.push(root);

    const result = createWorkflowFile("my-test", root);
    expect(result.id).toBe("my-test");
    expect(existsSync(result.path)).toBe(true);
    expect(result.sourceType).toBe("generated");
  });

  test("file contains source and display-name markers", () => {
    const root = makeTempDir();
    dirs.push(root);

    const result = createWorkflowFile("hello-world", root);
    const contents = readFileSync(result.path, "utf8");
    expect(contents).toContain("smithers-source: generated");
    expect(contents).toContain("smithers-display-name: Hello World");
  });

  test("throws if workflow already exists", () => {
    const root = makeTempDir();
    dirs.push(root);

    createWorkflowFile("dupe", root);
    expect(() => createWorkflowFile("dupe", root)).toThrow("already exists");
  });

  test("validates name before creating", () => {
    const root = makeTempDir();
    dirs.push(root);

    expect(() => createWorkflowFile("Invalid_Name", root)).toThrow(
      "Invalid workflow name",
    );
  });

  test("creates directories recursively", () => {
    const root = makeTempDir();
    dirs.push(root);

    // .smithers/workflows/ doesn't exist yet
    const result = createWorkflowFile("deep", root);
    expect(existsSync(result.path)).toBe(true);
  });

  test("created file is discoverable", () => {
    const root = makeTempDir();
    dirs.push(root);

    createWorkflowFile("findme", root);
    const workflows = discoverWorkflows(root);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].id).toBe("findme");
    expect(workflows[0].sourceType).toBe("generated");
  });

  test("display name capitalizes each word", () => {
    const root = makeTempDir();
    dirs.push(root);

    const result = createWorkflowFile("multi-word-name", root);
    const contents = readFileSync(result.path, "utf8");
    expect(contents).toContain("smithers-display-name: Multi Word Name");
  });

  test("file contains JSX import source", () => {
    const root = makeTempDir();
    dirs.push(root);

    const result = createWorkflowFile("jsx-test", root);
    const contents = readFileSync(result.path, "utf8");
    expect(contents).toContain("@jsxImportSource");
  });
});
