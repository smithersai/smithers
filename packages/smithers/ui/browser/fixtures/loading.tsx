/** @jsxImportSource react */
/**
 * The page the loading probes load: the page's LoadingBar, a region whose content stands in as a Skeleton of its
 * size while it loads, an answer that is pending while it loads and then one line, and a Save button that loads.
 * `window.load(ms)` starts a load that settles after `ms`; every probe drives the page through it.
 */
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button } from "../../src/button";
import { ChatMessage } from "../../src/chat/ChatMessage";
import { ChatTranscript } from "../../src/chat/ChatTranscript";
import { LoadingBar } from "../../src/loading";
import { Skeleton } from "../../src/skeleton";
import { SmithersUiStyles } from "../../src/styles";

type Phase = "idle" | "loading" | "done";

declare global {
  interface Window {
    load: (ms: number) => void;
  }
}

let setPhase: (phase: Phase) => void = () => {};
window.load = (ms) => {
  // A probe must observe the committed loading DOM before controlling its native animations.
  flushSync(() => setPhase("loading"));
  setTimeout(() => setPhase("done"), ms);
};

function Host() {
  const [phase, set] = useState<Phase>("idle");
  setPhase = set;
  const loading = phase === "loading";
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: 16, height: "100vh", padding: 16 }}>
      <SmithersUiStyles withTheme />
      <LoadingBar loading={loading} label="Loading page" />
      <section data-testid="region" style={{ width: 320 }}>
        {phase === "done" ? (
          <p data-testid="content" style={{ height: 48, margin: 0 }}>Loaded</p>
        ) : loading ? (
          <Skeleton data-testid="skeleton" style={{ height: 48 }} />
        ) : (
          <div style={{ height: 48 }} />
        )}
      </section>
      <p data-testid="below" style={{ margin: 0 }}>Below</p>
      <Button loading={loading}>Save</Button>
      <ChatTranscript>
        {phase === "idle" ? null : (
          <ChatMessage role="assistant" data-id="answer" pending={loading}>
            {loading ? null : "One line."}
          </ChatMessage>
        )}
      </ChatTranscript>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<Host />);
