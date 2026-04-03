// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { readdirSync } from "node:fs";

export function WorkflowLauncher({ onClose }: { onClose: () => void }) {
  const [examples, setExamples] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    try {
      const files = readdirSync("examples").filter(f => f.endsWith(".tsx") || f.endsWith(".ts")).filter(f => !f.startsWith("_"));
      setExamples(files);
    } catch {
      setExamples([]);
    }
  }, []);

  useKeyboard((key) => {
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      onClose();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((s) => Math.min(s + 1, Math.max(0, examples.length - 1)));
    }
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((s) => Math.max(s - 1, 0));
    }
    if (key.name === "enter" || key.name === "return") {
      if (examples[selectedIndex]) {
        // spawn the workflow
        const file = examples[selectedIndex];
        try {
          const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", "up", `examples/${file}`, "-d"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          proc.unref(); // allow the parent process (TUI) to exit independently
        } catch {}
        onClose();
      }
    }
  });

  return (
    <box
      style={{
        flexGrow: 1,
        width: "100%",
        height: "100%",
        border: true,
        borderColor: "yellow",
        flexDirection: "column",
      }}
      title="Launch Workflow [Esc to Close, Enter to Run]"
    >
      <text style={{ margin: 1, color: "gray" }}>Select an example to run in the background:</text>
      {examples.length === 0 ? (
        <text style={{ margin: 1 }}>No examples found in ./examples</text>
      ) : (
        <scrollbox style={{ width: "100%", height: "100%", flexDirection: "column", paddingLeft: 2 }}>
          {examples.map((ex, i) => (
            <text key={ex} style={{ color: selectedIndex === i ? "green" : "white" }}>
              {selectedIndex === i ? "▶ " : "  "}{ex}
            </text>
          ))}
        </scrollbox>
      )}
    </box>
  );
}
