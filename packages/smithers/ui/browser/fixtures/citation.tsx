/** Real rich citation in paragraph flow, including pointer hit testing between trigger and preview. */
import { createRoot } from "react-dom/client";
import { InlineCitation } from "../../src/agentic/InlineCitation";
import { SmithersUiStyles } from "../../src/styles";

createRoot(document.getElementById("app")!).render(<>
  <SmithersUiStyles withTheme />
  <p>Read the report <InlineCitation index={1} label="Report" sources={[{
    id: "report", title: "Report", url: "https://example.test/report",
    excerpt: "A source preview that a person can reach with a pointer or keyboard.",
  }]} /> for details.</p>
  <p style={{ width: 170 }}><span style={{ display: "inline-block", width: 130 }}>Near line end</span> <InlineCitation index={2} label="Narrow report" sources={[{
    id: "narrow", title: "Narrow report", url: "https://example.test/narrow",
    excerpt: "A source preview longer than the remaining line width.",
  }]} /></p>
  <button id="outside">Outside</button>
</>);
