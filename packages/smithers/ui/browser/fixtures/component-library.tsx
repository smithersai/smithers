/** @jsxImportSource react */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Calendar } from "../../src/calendar/Calendar";
import { TestSuite, TestSuiteName, TestRow, TestResults, TestResultsProgress } from "../../src/artifacts/TestResults";
import { Sources, SourcesTrigger, SourcesContent, Source } from "../../src/agentic/Sources";
import { ChangeSummary } from "../../src/artifacts/ChangeSummary";

const NOW = new Date(2026, 6, 27, 12).getTime();
const START = new Date(2026, 6, 27, 9).getTime();
const events = [
  { id: "first", title: "First event", start: START, end: START + 3_600_000, href: "#first" },
  { id: "second", title: "Second event", start: START, end: START + 3_600_000, href: "#second" },
];

function App() {
  const [slots, setSlots] = useState(0);
  return <main style={{ width: 1000 }}>
    <section data-example="week"><Calendar events={events} now={NOW} view="week" /></section>
    <section data-example="agenda"><Calendar events={events} now={NOW} view="agenda" /></section>
    <section data-example="month"><Calendar events={events} now={NOW} maxChipsPerDay={1} onSlotClick={() => setSlots((n) => n + 1)} /></section>
    <output aria-label="Slot clicks">{slots}</output>
    <TestSuite><TestSuiteName>API suite</TestSuiteName><TestRow test={{ id: "ok", name: "responds", status: "passed" }} /></TestSuite>
    <Sources defaultOpen><SourcesTrigger count={2} /><SourcesContent><Source title="Alpha" /><Source title="Beta" /></SourcesContent></Sources>
    <ChangeSummary additions={1} deletions={1} filesChanged={1} compact />
    <TestResults suites={[{ id: "api", name: "api", tests: [{ id: "ok", name: "ok", status: "passed" }, { id: "todo", name: "todo", status: "todo" }] }]}><TestResultsProgress /></TestResults>
  </main>;
}
createRoot(document.getElementById("app")!).render(<App />);

