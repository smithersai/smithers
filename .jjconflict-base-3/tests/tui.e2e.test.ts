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
      // 1. Verify the V2 TopBar renders the Smithers header
      await tui.waitForText("Smithers");

      // 2. Verify the V2 layout shows the Inspector pane
      await tui.waitForText("Inspector");

      // 3. Verify the Composer hint text renders
      await tui.waitForText("Type a task");

      // 4. Wait for the broker to sync and detect the background workflow
      await tui.waitForText("fan-out-fan-in");

      // 5. Navigate to the feed region (Tab to cycle focus)
      tui.sendKeys("\t"); // Tab to cycle focus to feed
      await new Promise(r => setTimeout(r, 300));

      // 6. Open the selected feed entry to drill into the Inspector
      tui.sendKeys("\r"); // Enter to inspect the selected entry
      await new Promise(r => setTimeout(r, 300));

      // The Inspector should now show run details
      await tui.waitForText("Inspector");

      // 7. Press Esc to return focus to the Composer
      tui.sendKeys("\x1b");
      await new Promise(r => setTimeout(r, 300));

      // 8. Test the command palette (Ctrl+O)
      tui.sendKeys("\x0f"); // Ctrl+O opens the palette
      await tui.waitForText("Focus composer");
      tui.sendKeys("\x1b"); // Close palette
    } catch (err) {
      require("fs").writeFileSync("tui-buffer.txt", tui.snapshot());
      throw err;
    } finally {
      await tui.terminate();
    }
  }, 15000); // give it up to 15s to poll correctly
});
