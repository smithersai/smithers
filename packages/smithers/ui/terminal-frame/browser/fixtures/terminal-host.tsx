/** @jsxImportSource react */
/**
 * The page the terminal frame probe loads: a TerminalFrame whose stream
 * writes `window.probe.output`, logging what reaches the page.
 */
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { TerminalFrame, type TerminalFrameHandle, type TerminalFrameKey } from "../../src/index";

declare global {
  interface Window {
    probe: { readonly output: string; readonly readOnly: boolean; readonly screenReaderMode?: boolean; readonly width?: number };
    log: {
      inputs: Array<string>;
      sizes: Array<[number, number]>;
      keys: Array<TerminalFrameKey>;
      links: Array<{ url: string; active: boolean | undefined }>;
    };
    focusTerminal: () => void;
  }
}

window.log = { inputs: [], sizes: [], keys: [], links: [] };
const handle = createRef<TerminalFrameHandle>();
window.focusTerminal = () => handle.current?.focus();

const app = document.getElementById("app");
if (app !== null) {
  createRoot(app).render(
    <>
    <button id="before-terminal">Before</button>
    <TerminalFrame
      ref={handle}
      title="Probe terminal"
      theme="light"
      readOnly={window.probe.readOnly}
      screenReaderMode={window.probe.screenReaderMode}
      style={{ height: 300, width: window.probe.width ?? 800 }}
      stream={(write) => {
        write.output(window.probe.output);
        return () => {};
      }}
      onInput={(data) => window.log.inputs.push(data)}
      onResize={(cols, rows) => window.log.sizes.push([cols, rows])}
      onKey={(key) => window.log.keys.push(key)}
      onLink={(url) =>
        window.log.links.push({
          url,
          active: (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive,
        })}
    />
    <button id="after-terminal">After</button>
    </>,
  );
}
