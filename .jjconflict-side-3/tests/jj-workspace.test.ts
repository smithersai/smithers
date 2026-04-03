import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as vcs from "../src/vcs/jj";

async function withFakeJj(script: string, fn: () => Promise<void>) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jj-bin-"));
  const binPath = path.join(tmp, process.platform === "win32" ? "jj.cmd" : "jj");
  const content = process.platform === "win32"
    ? `@echo off\r\n${script.replaceAll("\n", "\r\n")}`
    : `#!/usr/bin/env bash\nset -euo pipefail\n${script}`;
  await fs.writeFile(binPath, content, { mode: 0o755 });
  const prevPath = process.env.PATH || "";
  process.env.PATH = `${tmp}${path.delimiter}${prevPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
  }
}

describe("runJj", () => {
  test("returns non-zero and stderr on failure", async () => {
    await withFakeJj(
      `echo "bad flag" 1>&2; exit 2`,
      async () => {
        const res = await vcs.runJj(["--does-not-exist"]);
        expect(res.code).not.toBe(0);
        expect(res.stderr).toContain("bad flag");
      },
    );
  });

  test("returns code 0 and stdout on success", async () => {
    await withFakeJj(
      `echo "ok"; exit 0`,
      async () => {
        const res = await vcs.runJj(["echo-ok"]);
        expect(res.code).toBe(0);
        expect(res.stdout.trim()).toBe("ok");
      },
    );
  });

  test("forwards cwd option to spawned process", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-cwd-"));
    await withFakeJj(
      `pwd; exit 0`,
      async () => {
        const res = await vcs.runJj(["echo-pwd"], { cwd: tmpCwd });
        expect(res.code).toBe(0);
        const got = res.stdout.trim();
        // macOS may prefix /private for /var; compare realpaths
        const realGot = await fs.realpath(got).catch(() => got);
        const realTmp = await fs.realpath(tmpCwd).catch(() => tmpCwd);
        expect(realGot).toBe(realTmp);
      },
    );
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });

  test("normalizes spawn failure to code 127 (jj missing)", async () => {
    const prev = process.env.PATH || "";
    process.env.PATH = "/nonexistent"; // ensure jj cannot spawn
    try {
      const res = await vcs.runJj(["--version"]);
      expect(res.code).toBe(127);
    } finally {
      process.env.PATH = prev;
    }
  });
});

describe("isJjRepo", () => {
  test("true when log command succeeds with --no-graph", async () => {
    const script = `
case "$1 $2 $3 $4 $5 $6" in
  "log -r @ -n 1 --no-graph") echo ok; exit 0;;
  *) echo unknown 1>&2; exit 1;;
esac
`;
    await withFakeJj(script, async () => {
      const ok = await vcs.isJjRepo();
      expect(ok).toBe(true);
    });
  });

  test("false when jj returns non-zero", async () => {
    const script = `
exit 1
`;
    await withFakeJj(script, async () => {
      const ok = await vcs.isJjRepo();
      expect(ok).toBe(false);
    });
  });

  test("forwards cwd to repo check command", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-repo-"));
    await fs.writeFile(path.join(tmpCwd, ".cwd"), "x");
    const script = `
if [[ "$1" = "log" && "$2" = "-r" && "$3" = "@" && "$4" = "-n" && "$5" = "1" && "$6" = "--no-graph" ]]; then
  if [[ -f ./.cwd ]]; then
    exit 0
  else
    exit 9
  fi
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const ok = await vcs.isJjRepo(tmpCwd);
      expect(ok).toBe(true);
    });
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });
});

describe("workspaceAdd", () => {
  test("uses primary syntax: path then --name", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "add" && "$4" = "--name" && "$6" = "-r" ]]; then
  # "$3" is path, "$5" is name, "$7" is rev
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("myws", "/tmp/wc", { atRev: "abc" });
      expect(res.success).toBe(true);
    });
  });

  test("primary syntax without atRev (no -r)", async () => {
    const script = `
case "$1 $2 $3 $4 $5" in
  "workspace add /tmp/wc2 --name noRev") exit 0;;
  *) exit 1;;
esac
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("noRev", "/tmp/wc2");
      expect(res.success).toBe(true);
    });
  });

  test("falls back to legacy name path form", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "add" && "$3" != "--wc-path" && "$3" != "-r" && "$6" = "-r" ]]; then
  # legacy: name path -r rev  (positions 3,4,6)
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("legacy", "/tmp/legacy", { atRev: "zzz" });
      expect(res.success).toBe(true);
    });
  });

  test("returns error when all syntax attempts fail", async () => {
    const script = `
exit 3
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("bad", "/nope/path", { atRev: "r" });
      expect(res.success).toBe(false);
      expect(typeof res.error).toBe("string");
      expect((res.error ?? "").length).toBeGreaterThan(0);
    });
  });

  test("supports --wc-path fallback variant", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "add" && "$3" = "--wc-path" ]]; then
  # args: --wc-path <path> <name> [-r <rev>]
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceAdd("name", "/tmp/alt");
      expect(res.success).toBe(true);
    });
  });
});

describe("workspaceList", () => {
  test("uses -T for structured names output", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "list" && "$3" = "-T" ]]; then
  # print only names, one per line
  echo "default"
  echo "other"
  echo "solo"
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const rows = await vcs.workspaceList();
      expect(rows).toEqual([
        { name: "default", path: null, selected: false },
        { name: "other", path: null, selected: false },
        { name: "solo", path: null, selected: false },
      ]);
    });
  });

  test("falls back to parsing human output when -T not supported", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "list" && "$#" -ge 3 && "$3" = "-T" ]]; then
  exit 2
fi
if [[ "$1" = "workspace" && "$2" = "list" ]]; then
  echo "* default"
  echo "other"
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const rows = await vcs.workspaceList();
      expect(rows).toEqual([
        { name: "default", path: null, selected: true },
        { name: "other", path: null, selected: false },
      ]);
    });
  });

  test("returns [] when jj list fails", async () => {
    const script = `
exit 1
`;
    await withFakeJj(script, async () => {
      const rows = await vcs.workspaceList();
      expect(rows).toEqual([]);
    });
  });

  test("propagates cwd to list command", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-wslist-"));
    await fs.writeFile(path.join(tmpCwd, ".sentinel"), "x");
    const script = `
if [[ "$1" = "workspace" && "$2" = "list" && "$3" = "-T" ]]; then
  if [[ -f ./.sentinel ]]; then
    echo default
    exit 0
  else
    exit 5
  fi
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const rows = await vcs.workspaceList(tmpCwd);
      expect(rows.length).toBe(1);
      expect(rows[0]!.name).toBe("default");
    });
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });
});

describe("workspaceClose", () => {
  test("uses forget subcommand", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "forget" && "$3" = "myws" ]]; then
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceClose("myws");
      expect(res.success).toBe(true);
    });
  });

  test("returns error when forget fails", async () => {
    const script = `
if [[ "$1" = "workspace" && "$2" = "forget" ]]; then
  echo "boom" 1>&2
  exit 3
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceClose("bad");
      expect(res.success).toBe(false);
      expect(res.error).toContain("boom");
    });
  });

  test("propagates cwd to forget", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-wsc-"));
    await fs.writeFile(path.join(tmpCwd, ".sentinel"), "x");
    const script = `
if [[ "$1" = "workspace" && "$2" = "forget" && "$3" = "x" ]]; then
  if [[ -f ./.sentinel ]]; then
    exit 0
  else
    exit 7
  fi
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.workspaceClose("x", { cwd: tmpCwd });
      expect(res.success).toBe(true);
    });
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });
});

describe("getJjPointer", () => {
  test("returns trimmed change_id string", async () => {
    const script = `
if [[ "$1" = "log" && "$2" = "-r" && "$3" = "@" && "$4" = "--no-graph" && "$5" = "--template" && "$6" = "change_id" ]]; then
  echo "abc123"
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const ptr = await vcs.getJjPointer();
      expect(ptr).toBe("abc123");
    });
  });

  test("returns null when jj fails", async () => {
    const script = `
exit 1
`;
    await withFakeJj(script, async () => {
      const ptr = await vcs.getJjPointer();
      expect(ptr).toBeNull();
    });
  });

  test("returns null when stdout is empty", async () => {
    const script = `
if [[ "$1" = "log" ]]; then
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const ptr = await vcs.getJjPointer();
      expect(ptr).toBeNull();
    });
  });

  test("propagates cwd to log command", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-ptr-"));
    await fs.writeFile(path.join(tmpCwd, ".sentinel"), "x");
    const script = `
if [[ "$1" = "log" && "$2" = "-r" && "$3" = "@" && "$4" = "--no-graph" && "$5" = "--template" && "$6" = "change_id" ]]; then
  if [[ -f ./.sentinel ]]; then
    echo ptr
    exit 0
  else
    exit 9
  fi
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const ptr = await vcs.getJjPointer(tmpCwd);
      expect(ptr).toBe("ptr");
    });
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });
});

describe("revertToJjPointer", () => {
  test("success returns {success:true}", async () => {
    const script = `
if [[ "$1" = "restore" && "$2" = "--from" && "$3" = "abc" ]]; then
  exit 0
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.revertToJjPointer("abc");
      expect(res.success).toBe(true);
    });
  });

  test("failure returns error string", async () => {
    const script = `
if [[ "$1" = "restore" && "$2" = "--from" ]]; then
  echo "bad restore" 1>&2
  exit 5
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.revertToJjPointer("oops");
      expect(res.success).toBe(false);
      expect(res.error).toContain("bad restore");
    });
  });

  test("uses provided cwd for restore command", async () => {
    const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jj-rev-"));
    // Create a sentinel file that should be visible only if cwd is set correctly
    await fs.writeFile(path.join(tmpCwd, ".cwd-sentinel"), "x");
    const script = `
if [[ "$1" = "restore" && "$2" = "--from" && "$3" = "abc" ]]; then
  if [[ -f ./.cwd-sentinel ]]; then
    exit 0
  else
    echo "missing sentinel in $PWD" 1>&2
    exit 7
  fi
fi
exit 1
`;
    await withFakeJj(script, async () => {
      const res = await vcs.revertToJjPointer("abc", tmpCwd);
      expect(res.success).toBe(true);
    });
    try { await fs.rm(tmpCwd, { recursive: true, force: true }); } catch {}
  });
});
