/** @jsxImportSource react */
/**
 * The page the browser probes load: a GeneratedView with the props a probe
 * sets on `window.probe`, logging what reaches the page.
 */
import type { Interactions } from "@smthrs/views";
import { createRoot } from "react-dom/client";
import { GeneratedView } from "../../src/generated-view";
import { sanitize } from "../../src/generated-view/sanitize";

interface Probe {
  readonly html: string;
  readonly interactions: Interactions.Declared;
  readonly runtime?: string;
  readonly styles?: string;
  readonly siblings?: boolean;
}

declare global {
  interface Window {
    probe: Probe;
    updateProbe: (props: Partial<Probe>) => void;
    log: { interactions: Array<unknown>; refusals: Array<string>; messages: Array<unknown> };
    sanitizeHtml: (html: string) => { html: string; elements: Array<string>; attributes: Array<string> };
  }
}

window.log = { interactions: [], refusals: [], messages: [] };
window.addEventListener("message", (event) => {
  if (typeof event.data === "string") window.log.messages.push(event.data);
});

window.sanitizeHtml = (html) => {
  const container = document.createElement("div");
  container.appendChild(sanitize(html, document, new DOMParser()));
  const all = Array.from(container.querySelectorAll("*"));
  return {
    html: container.innerHTML,
    elements: all.map((element) => element.localName),
    attributes: all.flatMap((element) =>
      Array.from(element.attributes, (attribute) => `${element.localName} ${attribute.name}=${attribute.value}`)
    ),
  };
};

const app = document.getElementById("app");
if (app !== null) {
  const root = createRoot(app);
  window.updateProbe = (props) => {
    window.probe = { ...window.probe, ...props };
    root.render(
      <>{[0, ...(window.probe.siblings ? [1] : [])].map((key) => <GeneratedView key={key}
        html={window.probe.html}
        interactions={window.probe.interactions}
        runtime={window.probe.runtime}
        styles={window.probe.styles}
        title="Probe"
        theme="light"
        size="full"
        style={{ height: 400 }}
        onInteraction={(interaction) => window.log.interactions.push(interaction)}
        onRefused={(reason) => window.log.refusals.push(reason)}
      />)}</>,
    );
  };
  window.updateProbe({});
}
