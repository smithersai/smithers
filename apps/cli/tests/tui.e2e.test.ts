import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchTUI, BUN, TUI_ENTRY } from "../../smithers/tests/tui-helpers";

const TUI_WAIT_TIMEOUT_MS = 20_000;
const TUI_TEST_TIMEOUT_MS = 30_000;

describe("TUI E2E", () => {
  let testDir: string;
  const runLabel = "fan-out-fan";

  beforeAll(async () => {
    const workflowPath = resolve(process.cwd(), "examples/fan-out-fan-in.tsx");
    testDir = await mkdtemp(join(tmpdir(), "smithers-tui-e2e-"));

    // Run a background workflow to ensure the database has something
    const proc = Bun.spawnSync([BUN, "run", TUI_ENTRY, "up", workflowPath, "-d"], {
      cwd: testDir,
      env: { ...process.env },
    });
    
    if (proc.exitCode !== 0) {
      console.error(proc.stderr?.toString() ?? "Unknown error spawning background workflow");
      throw new Error("Failed to start fan-out-fan-in workflow in e2e setup");
    }
  }, TUI_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("TUI displays the fan-out-fan-in run in the RunsPane", async () => {
    const tui = await launchTUI(["tui"], { cwd: testDir });
    
    try {
      // Verify basic layout components
      await tui.waitForText("Smithers Runs", TUI_WAIT_TIMEOUT_MS);

      // Verify the background workflow was detected
      await tui.waitForText(runLabel, TUI_WAIT_TIMEOUT_MS);

      // 2. Test RunDetailView Drill Down
      // Open the detail for the focused run
      tui.sendKeys("\r"); // Enter key
      
      await tui.waitForText("Run Tasks", TUI_WAIT_TIMEOUT_MS);
      await tui.waitForText("Entire Run", TUI_WAIT_TIMEOUT_MS);
      
      // 3. Test Level 3 Drill Down (Node Detail)
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("\r"); // Enter key
      
      await tui.waitForText("Task Inspector", TUI_WAIT_TIMEOUT_MS);
      
      // Press 1 to ensure Input rendering works natively (and parses metaJson/configJson)
      tui.sendKeys("1");
      await tui.waitForText("Input", TUI_WAIT_TIMEOUT_MS);

      // Press 2 to ensure output rendering works natively
      tui.sendKeys("2");
      await tui.waitForText("Output", TUI_WAIT_TIMEOUT_MS);

      // 4. Back out to Master List and Test Global Keyboard Filters
      tui.sendKeys("\x1b"); // Esc to RunDetailView
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("\x1b"); // Esc to RunsList
      await new Promise(r => setTimeout(r, 200));

      // Test Pending Inbox Toggle
      tui.sendKeys("p");
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("p"); // Toggle back
      await tui.waitForText(runLabel, TUI_WAIT_TIMEOUT_MS);

      // Test Agent Ask Modal
      tui.sendKeys("a");
      await tui.waitForText("Ask Smithers", TUI_WAIT_TIMEOUT_MS);
      await tui.waitForText("What would you like to know", TUI_WAIT_TIMEOUT_MS);
      tui.sendKeys("\x1b"); // Close Ask Modal
    } catch (err) {
      require("fs").writeFileSync("tui-buffer.txt", tui.snapshot());
      throw err;
    } finally {
      await tui.terminate();
    }
  }, TUI_TEST_TIMEOUT_MS);
});
