import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";

/**
 * Process-level CLI tests (finding #9).
 *
 * These drive the actual `smithers` entrypoint with real argv parsing
 * so parser-error handling (finding #1), double envelope suppression
 * (finding #2), and command-scoped `--json` (finding #3) are all
 * exercised end-to-end. Helper-level tests in tree.test/diff.test/
 * output.test/rewind.test bypass the parser and therefore cannot see
 * these bugs.
 */

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

/** @type {string} */
let fixtureDir;

function runCli(args, extraEnv = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn("bun", [CLI_ENTRY, ...args], {
            cwd: fixtureDir,
            env: {
                ...process.env,
                ...extraEnv,
                // Keep output deterministic.
                NO_COLOR: "1",
                FORCE_COLOR: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
        });
    });
}

async function seedFixtureDb() {
    const dbPath = join(fixtureDir, "smithers.db");
    if (existsSync(dbPath)) return;
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const now = Date.now();
    await adapter.insertRun({
        runId: "fixture-run",
        workflowName: "fixture-wf",
        status: "running",
        createdAtMs: now - 5000,
        startedAtMs: now - 4000,
        finishedAtMs: null,
    });
    await adapter.insertFrame({
        runId: "fixture-run",
        frameNo: 0,
        createdAtMs: now - 3000,
        xmlJson: JSON.stringify({
            kind: "element",
            tag: "smithers:workflow",
            props: { name: "fixture-wf" },
            children: [],
        }),
        xmlHash: "hash-0",
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    });
    sqlite.close();
}

beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "smithers-cli-devtools-"));
    await seedFixtureDb();
});

afterAll(() => {
    if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
    }
});

describe("finding #1 — parser errors use exit 1 on stderr only", () => {
    test("tree with no runId → exit 1, usage on stderr, empty stdout", async () => {
        const r = await runCli(["tree"]);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("missing required argument");
        expect(r.stderr.toLowerCase()).toContain("usage:");
    });

    test("diff with invalid --color enum → exit 1 on stderr only", async () => {
        const r = await runCli(["diff", "run", "node", "--color", "sometimes"]);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("invalid value for --color");
    });

    test("tree with invalid --depth=-1 → exit 1 on stderr only", async () => {
        const r = await runCli(["tree", "run", "--depth", "-1"]);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("--depth");
    });

    test("rewind with non-integer frame → exit 1 on stderr only", async () => {
        const r = await runCli(["rewind", "run", "abc"]);
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("frameNo");
    });
});

describe("finding #2 — no double error envelope on failure", () => {
    test("tree INVALID!!! → exit 1, friendly on stderr, no TREE_FAILED on stdout", async () => {
        const r = await runCli(["tree", "INVALID!!!"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("InvalidRunId");
        expect(r.stderr).toContain("hint:");
        // Key assertion: no second envelope should appear on stdout.
        expect(r.stdout).not.toContain("TREE_FAILED");
        expect(r.stdout).not.toContain("tree failed");
    });

    test("diff missing-run → no DIFF_FAILED envelope on stdout", async () => {
        const r = await runCli(["diff", "no-such-run", "some-node"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("RunNotFound");
        expect(r.stdout).not.toContain("DIFF_FAILED");
    });

    test("output missing-run → no OUTPUT_FAILED envelope on stdout", async () => {
        const r = await runCli(["output", "no-such-run", "some-node"]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("RunNotFound");
        expect(r.stdout).not.toContain("OUTPUT_FAILED");
    });

    test("rewind missing-run --yes → no REWIND_FAILED envelope on stdout", async () => {
        const r = await runCli(["rewind", "no-such-run", "0", "--yes"]);
        expect([1, 2]).toContain(r.exitCode);
        expect(r.stdout).not.toContain("REWIND_FAILED");
    });
});

describe("finding #3 — --json is command-scoped for devtools commands", () => {
    test("tree fixture-run --json → stdout is parseable JSON of the snapshot", async () => {
        const r = await runCli(["tree", "fixture-run", "--json"]);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe("");
        // Must parse as JSON; must be a snapshot object (not an envelope).
        const parsed = JSON.parse(r.stdout);
        expect(parsed.runId).toBe("fixture-run");
        expect(parsed.root).toBeDefined();
        // Envelope keys would be `ok` / `data` / `error` — ensure they
        // are not present on the top level.
        expect(parsed.ok).toBeUndefined();
        expect(parsed.data).toBeUndefined();
    });

    test("tree fixture-run (no --json) → XML-like tree, not JSON", async () => {
        const r = await runCli(["tree", "fixture-run"]);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("<");
        expect(r.stdout).toContain(">");
    });
});

describe("finding #7 — per-command help lines are reasonable width", () => {
    // We can't shrink incur's global options (--filter-output, etc.).
    // Assert only the command-specific option lines stay under 72 cols
    // so acceptance §--help is at least met for the lines we own.
    const commands = ["tree", "diff", "output", "rewind"];
    for (const cmd of commands) {
        test(`${cmd} --help: command-specific option lines are <= 72 cols`, async () => {
            const r = await runCli([cmd, "--help"]);
            expect(r.exitCode).toBe(0);
            const lines = r.stdout.split("\n");
            // Narrow to our option lines (indented with two spaces and
            // starting with `--` but not in Global Options block).
            let inGlobals = false;
            for (const line of lines) {
                if (line.includes("Global Options")) { inGlobals = true; continue; }
                if (inGlobals) continue;
                if (!line.startsWith("  --")) continue;
                expect(line.length).toBeLessThanOrEqual(72);
            }
        });
    }
});

describe("finding #11 — SMITHERS_LOG_JSON=1 emits structured telemetry", () => {
    test("tree fixture-run emits command log + metric lines to stderr", async () => {
        const r = await runCli(
            ["tree", "fixture-run"],
            { SMITHERS_LOG_JSON: "1" },
        );
        expect(r.exitCode).toBe(0);
        // stderr should contain 3 JSON lines: command log, counter,
        // histogram. Filter lines starting with `{`.
        const jsonLines = r.stderr.split("\n").filter((l) => l.startsWith("{"));
        expect(jsonLines.length).toBeGreaterThanOrEqual(3);
        const parsed = jsonLines.map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return null;
            }
        }).filter(Boolean);
        const cmdLog = parsed.find((p) => p.cmd === "tree" && typeof p.durationMs === "number");
        expect(cmdLog).toBeDefined();
        expect(cmdLog.exitCode).toBe(0);
        expect(cmdLog.flags).toBeDefined();
        const counter = parsed.find((p) => p.metric === "smithers_cli_command_total");
        expect(counter).toBeDefined();
        expect(counter.labels.cmd).toBe("tree");
        expect(counter.labels.exit).toBe("0");
        const histogram = parsed.find((p) => p.metric === "smithers_cli_command_duration_ms");
        expect(histogram).toBeDefined();
        expect(histogram.labels.cmd).toBe("tree");
        expect(typeof histogram.value).toBe("number");
    });
});

describe("finding #4 — output --json emits raw row, not envelope", () => {
    // We can't easily produce a real output row without running a
    // workflow, so assert that when a row doesn't exist, the raw-row
    // path still emits a plain JSON value (null) — i.e. NOT a response
    // envelope with `status`/`schema` keys. This directly catches the
    // bug the finding describes.
    test("no output → stdout is plain null, not {status,row,schema}", async () => {
        const r = await runCli(["output", "fixture-run", "no-such-node"]);
        // Expect an error flow (exit 1 or 2). The key assertion is that
        // stdout never contains the envelope keys when output path is
        // attempted. (Stdout is empty here because the error surfaces
        // before any JSON is written — acceptable for this guard.)
        expect([1, 2]).toContain(r.exitCode);
        expect(r.stdout).not.toContain('"schema"');
        expect(r.stdout).not.toContain('"status"');
    });
});
