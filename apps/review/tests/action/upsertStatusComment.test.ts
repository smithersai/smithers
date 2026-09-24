import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertStatusComment } from "../../action/src/upsertStatusComment.ts";

const MARKER = "<!-- smithers-review-status -->";

interface GhCall {
  repoDir: string;
  args: string[];
  stdin?: string;
}

function stubGh(listResponse: string) {
  const calls: GhCall[] = [];
  const runGh = async (repoDir: string, args: string[], stdin?: string) => {
    calls.push({ repoDir, args, stdin });
    if (args.includes("--paginate")) return listResponse;
    return "";
  };
  return { calls, runGh };
}

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

describe("upsertStatusComment", () => {
  test("creates a marker comment when no existing comment matches", async () => {
    const { calls, runGh } = stubGh("");
    await upsertStatusComment({
      workspace: "/ws",
      repository: "octo/widgets",
      prNumber: 7,
      body: "🔍 smithers review started",
      runGh,
    });
    expect(calls).toHaveLength(2);
    const create = calls[1]!;
    expect(create.args).toContain("POST");
    expect(create.args).toContain("repos/octo/widgets/issues/7/comments");
    const body = (JSON.parse(create.stdin ?? "{}") as { body: string }).body;
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("🔍 smithers review started");
  });

  test("updates the existing marker comment instead of duplicating", async () => {
    const { calls, runGh } = stubGh("123456\n");
    await upsertStatusComment({
      workspace: "/ws",
      repository: "octo/widgets",
      prNumber: 7,
      body: "✅ smithers review finished",
      runGh,
    });
    expect(calls).toHaveLength(2);
    const update = calls[1]!;
    expect(update.args).toContain("PATCH");
    expect(update.args).toContain("repos/octo/widgets/issues/comments/123456");
    const body = (JSON.parse(update.stdin ?? "{}") as { body: string }).body;
    expect(body).toBe(`${MARKER}\n✅ smithers review finished`);
  });

  test("does not adopt a user's marker comment", async () => {
    const calls: GhCall[] = [];
    const runGh = async (repoDir: string, args: string[], stdin?: string) => {
      calls.push({ repoDir, args, stdin });
      if (args.includes("--paginate")) {
        // Execute the actual query passed to gh against mixed-author API data.
        return execFileSync("jq", ["-r", args[args.indexOf("--jq") + 1]!], {
          encoding: "utf8", input: JSON.stringify([
            { id: 1, body: `${MARKER} forged`, user: { login: "contributor", type: "User" } },
            { id: 2, body: `${MARKER} actual`, user: { login: "github-actions[bot]", type: "Bot" } },
          ]),
        });
      }
      return "";
    };
    await upsertStatusComment({ workspace: "/ws", repository: "octo/widgets", prNumber: 7, body: "done", runGh });
    expect(calls[1]!.args).toContain("repos/octo/widgets/issues/comments/2");
  });

  test("gh failure degrades to a ::warning:: instead of throwing", async () => {
    const lines: string[] = [];
    console.log = (line: string) => {
      lines.push(String(line));
    };
    const runGh = async () => {
      throw new Error("gh api failed: boom");
    };
    await expect(
      upsertStatusComment({
        workspace: "/ws",
        repository: "octo/widgets",
        prNumber: 7,
        body: "🔍 smithers review started",
        runGh,
      }),
    ).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("::warning::") && l.includes("boom"))).toBe(true);
  });
});
