import { describe, test, expect, beforeAll } from "bun:test";
import { launchTUI, BUN, TUI_ENTRY } from "./tui-helpers.js";

describe("TUI E2E", () => {
  beforeAll(() => {
    // Run a background workflow to ensure the database has something
    const proc = Bun.spawnSync([BUN, "run", TUI_ENTRY, "up", "examples/fan-out-fan-in.tsx", "-d"], {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    
    if (proc.exitCode !== 0) {
      console.error(proc.stderr?.toString() ?? "Unknown error spawning background workflow");
      throw new Error("Failed to start fan-out-fan-in workflow in e2e setup");
    }
  });

  test("TUI displays the fan-out-fan-in run in the RunsPane", async () => {
    const tui = await launchTUI(["tui"]);
    
    try {
      // Verify basic layout components
      await tui.waitForText("Smithers Runs");

      // Verify the background workflow was detected
      await tui.waitForText("fan-out-fan-in");

      // 2. Test RunDetailView Drill Down
      // Open the detail for the focused run
      tui.sendKeys("\r"); // Enter key
      
      await tui.waitForText("Run Tasks");
      await tui.waitForText("Entire Run");
      
      // 3. Test Level 3 Drill Down (Node Detail)
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("\r"); // Enter key
      
      await tui.waitForText("Task Inspector");
      
      // Press 1 to ensure Input rendering works natively (and parses metaJson/configJson)
      tui.sendKeys("1");
      await tui.waitForText("Input");

      // Press 2 to ensure output rendering works natively
      tui.sendKeys("2");
      await tui.waitForText("Output");

      // 4. Back out to Master List and Test Global Keyboard Filters
      tui.sendKeys("\x1b"); // Esc to RunDetailView
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("\x1b"); // Esc to RunsList
      await new Promise(r => setTimeout(r, 200));

      // Test Pending Inbox Toggle
      tui.sendKeys("p");
      await new Promise(r => setTimeout(r, 200));
      tui.sendKeys("p"); // Toggle back
      await tui.waitForText("fan-out-fan-in");

      // Test Agent Ask Modal
      tui.sendKeys("a");
      await tui.waitForText("Ask Smithers");
      await tui.waitForText("What would you like to know");
      tui.sendKeys("\x1b"); // Close Ask Modal
    } catch (err) {
      require("fs").writeFileSync("tui-buffer.txt", tui.snapshot());
      throw err;
    } finally {
      await tui.terminate();
    }
  }, 15000); // give it up to 15s to poll correctly
});
