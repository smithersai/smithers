/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { SegmentedControl } from "../../src/segmented-control";
import { Textarea } from "../../src/input";
import { WebPageView } from "../../src/web-page/WebPageView";
import { Wordmark } from "../../src/wordmark/Wordmark";

const options = [
  { value: "json", label: "JSON" },
  { value: "table", label: "Table" },
  { value: "tree", label: "Tree", disabled: true },
];

createRoot(document.getElementById("app")!).render(
  <>
    <div id="full" style={{ width: 400, height: 520, display: "flex", flexDirection: "column" }}>
      <WebPageView url="https://outside.test/" size="full" />
    </div>
    <div id="inline" style={{ width: 400 }}>
      <WebPageView url="https://outside.test/" />
    </div>
    <SegmentedControl aria-label="Regular" value="json" options={options} onValueChange={() => {}} />
    <SegmentedControl aria-label="Small" size="sm" value="json" options={options} onValueChange={() => {}} />
    <Textarea code aria-label="Code" defaultValue="const answer = 42;" />
    <div style={{ width: 300 }}><Wordmark /></div>
  </>,
);
