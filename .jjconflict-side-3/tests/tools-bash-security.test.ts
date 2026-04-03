import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash, read, grep } from "../src/tools/index";
import { runWithToolContext } from "../src/tools/context";
import { ensureSmithersTables } from "../src/db/ensure";
import { SmithersDb } from "../src/db/adapter";
import { createTestDb } from "./helpers";
import { ddl, schema } from "./schema";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-bash-"));
}

async function execTool<T>(tool: any, input: any): Promise<T> {
  return tool.execute(input, {} as any);
}

async function withToolContext<T>(
  rootDir: string,
  fn: () => Promise<T>,
  overrides?: Partial<{
    allowNetwork: boolean;
    maxOutputBytes: number;
    timeoutMs: number;
  }>,
) {
  const { db, cleanup } = createTestDb(schema, ddl);
  ensureSmithersTables(db as any);
  const adapter = new SmithersDb(db as any);
  try {
    return await runWithToolContext(
      {
        db: adapter,
        runId: "run",
        nodeId: "node",
        iteration: 0,
        attempt: 1,
        rootDir,
        allowNetwork: overrides?.allowNetwork ?? false,
        maxOutputBytes: overrides?.maxOutputBytes ?? 200_000,
        timeoutMs: overrides?.timeoutMs ?? 5000,
        seq: 0,
      },
      fn,
    );
  } finally {
    cleanup();
  }
}

describe("bash tool network blocking", () => {
  test("blocks curl when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "curl", args: ["http://example.com"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks wget when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "wget", args: ["http://example.com"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks npm when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "npm", args: ["install", "lodash"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks bun when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "bun", args: ["install"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks pip when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "pip", args: ["install", "requests"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks URL in args when network disabled", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "echo", args: ["https://evil.com"] }),
        ),
      ).rejects.toThrow("Network access is disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bash tool git remote blocking", () => {
  test("blocks git push", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "git", args: ["push", "origin", "main"] }),
        ),
      ).rejects.toThrow("Git remote operations are disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks git pull", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "git", args: ["pull"] }),
        ),
      ).rejects.toThrow("Git remote operations are disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks git fetch", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "git", args: ["fetch", "origin"] }),
        ),
      ).rejects.toThrow("Git remote operations are disabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks git clone", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "git", args: ["clone", "https://github.com/repo"] }),
        ),
      ).rejects.toThrow(/Git remote operations are disabled|Network access is disabled/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows local git commands", async () => {
    const root = makeTempDir();
    try {
      // git init is a local-only command, should be allowed
      const result = await withToolContext(root, () =>
        execTool<string>(bash, { cmd: "git", args: ["init"] }),
      );
      expect(result).toContain("Initialized");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bash tool execution", () => {
  test("executes basic command and returns output", async () => {
    const root = makeTempDir();
    try {
      const result = await withToolContext(root, () =>
        execTool<string>(bash, { cmd: "echo", args: ["hello world"] }),
      );
      expect(result.trim()).toBe("hello world");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on non-zero exit code", async () => {
    const root = makeTempDir();
    try {
      await expect(
        withToolContext(root, () =>
          execTool(bash, { cmd: "false" }),
        ),
      ).rejects.toThrow("Command failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("read tool success", () => {
  test("reads file content", async () => {
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "test.txt"), "file content here", "utf8");
      const result = await withToolContext(root, () =>
        execTool<string>(read, { path: "test.txt" }),
      );
      expect(result).toBe("file content here");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("grep tool success", () => {
  test("finds matching lines", async () => {
    if (!Bun.which("rg")) return;
    const root = makeTempDir();
    try {
      writeFileSync(join(root, "code.ts"), "const foo = 1;\nconst bar = 2;\nconst foobar = 3;\n", "utf8");
      const result = await withToolContext(root, () =>
        execTool<string>(grep, { pattern: "foo", path: "." }),
      );
      expect(result).toContain("foo");
      expect(result).toContain("foobar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
