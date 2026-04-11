// @ts-nocheck
import React, { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";

export function AskModal({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<"input" | "streaming" | "done" | "error">("input");

  useKeyboard((key) => {
    if (key.name === "escape" || (key.name === "c" && key.ctrl)) {
      if (status !== "streaming") { // Or allow cancel mid-stream if we kill the proc? Keep simple for now
        onClose();
        return;
      }
    }

    if (status === "input") {
      if (key.name === "backspace") {
        setQuestion((q) => q.slice(0, -1));
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        if (question.trim().length > 0) {
          startAsk();
        }
        return;
      }
      
      // Basic typing capture (sequence is the literal ansi char)
      if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.name !== "up" && key.name !== "down" && key.name !== "left" && key.name !== "right") {
        setQuestion((q) => q + key.sequence);
      }
    }
  });

  async function startAsk() {
    setStatus("streaming");
    setAnswer("");
    try {
      const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", "ask", question], {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Stream stdout async
      (async () => {
        try {
            const stream = proc.stdout;
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            setAnswer((a) => a + text);
            }
        } catch {}
      })();

      // Stream stderr async (in case the agent prints progress or errors there)
      (async () => {
        try {
            const stream = proc.stderr;
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            setAnswer((a) => a + text);
            }
        } catch {}
      })();

      await proc.exited;
      if (proc.exitCode !== 0 && answer.trim().length === 0) {
         setAnswer("Failed to run ask command. Is your agent installed?");
         setStatus("error");
      } else {
         setStatus("done");
      }
    } catch (err: any) {
      setAnswer(`Spawn error: ${err.message}`);
      setStatus("error");
    }
  }

  // Auto scroll logic in OpenTUI: scrollboxes generally stay at the top unless navigated? 
  // For streaming, we'll just append text.

  return (
    <box
      style={{
        flexGrow: 1,
        width: "100%",
        height: "100%",
        border: true,
        borderColor: "magenta",
        flexDirection: "column",
      }}
      title={`Ask Smithers ${status === "input" ? "[Type Question, Enter to Submit, Esc to Close]" : "[Streaming... Esc to Close]"}`}
    >
      {status === "input" ? (
        <box style={{ flexDirection: "column", paddingLeft: 1, paddingTop: 1 }}>
          <text style={{ color: "cyan" }}>What would you like to know about the Smithers orchestrator?</text>
          <text style={{ color: "white", marginTop: 1 }}>{"> "}{question}█</text>
        </box>
      ) : (
        <scrollbox style={{ width: "100%", height: "100%", flexDirection: "column", paddingLeft: 1 }}>
          <text style={{ color: "cyan", marginBottom: 1 }}>Q: {question}</text>
          <text style={{ color: "white" }}>{answer}</text>
          {status === "done" && <text style={{ color: "green", marginTop: 1 }}>[ Agent finished. Press Esc to close. ]</text>}
          {status === "error" && <text style={{ color: "red", marginTop: 1 }}>[ Agent failed. Press Esc to close. ]</text>}
        </scrollbox>
      )}
    </box>
  );
}
