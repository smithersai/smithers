import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseCliAgent } from "../src/agents/BaseCliAgent";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class FailingCleanupAgent extends BaseCliAgent {
  constructor(private readonly markerPath: string) {
    super({ id: "cleanup-test-agent" });
  }

  protected async buildCommand(_params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    await writeFile(this.markerPath, "marker", "utf8");
    return {
      command: "smithers-command-that-does-not-exist",
      args: [],
      cleanup: async () => {
        await rm(this.markerPath, { force: true }).catch(() => undefined);
      },
    };
  }
}

describe("BaseCliAgent cleanup", () => {
  test("runs cleanup when runCommand rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smithers-basecli-cleanup-"));
    const markerPath = join(dir, "marker.txt");
    const agent = new FailingCleanupAgent(markerPath);

    try {
      await expect(
        agent.generate({
          prompt: "trigger failure",
        }),
      ).rejects.toThrow();
      expect(await exists(markerPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
