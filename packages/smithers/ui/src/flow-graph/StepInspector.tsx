/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { JsonValue } from "../json-value/JsonValue";
import type { JsonValueData } from "../json-value/jsonValueText";
import { attemptWords, stepDuration, stepElapsed, type AttemptRow, type StepRow } from "../run-page/runPage";
import { SpanDetail, type WaitData } from "../run-page/SpanDetail";
import { useInjectUiCss } from "../styles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs";
import { StepLogs } from "./StepLogs";
export type StepInspectorProps = Omit<ComponentProps<"section">, "children"> & {
  step: StepRow;
  input: JsonValueData | null;
  output: JsonValueData | null;
  logs: ReadonlyArray<JsonValueData>;
  attempts: ReadonlyArray<AttemptRow>;
  now: number;
  wait?: WaitData | null;
  actions?: ReactNode;
};
/** Run detail with no executable content or plugin-specific actions. */
export function StepInspector({ step, input, output, logs, attempts, now, wait, actions, className, ...props }: StepInspectorProps) {
  useInjectUiCss();
  return <section tabIndex={-1} aria-label={`Inspect ${step.label}`} data-slot="step-inspector" className={cn("sui-step-inspector", className)} {...props}>
    <SpanDetail label={step.label} state={step.state} input={null} output={null} attempts={[]} now={now} wait={wait} actions={actions} />
    <div className="sui-step-inspector-time"><span>{step.kind}</span><span>{stepDuration(step.state === "pending" ? 0 : stepElapsed(step, now))}</span></div>
    <Tabs defaultValue="output">
      <TabsList><TabsTrigger value="output">Output</TabsTrigger><TabsTrigger value="input">Input</TabsTrigger><TabsTrigger value="logs" count={logs.length}>Logs</TabsTrigger><TabsTrigger value="attempts" count={attempts.length}>Attempts</TabsTrigger></TabsList>
      <TabsContent value="output">{output === null ? null : <JsonValue label="Output" value={output} defaultOpen />}</TabsContent>
      <TabsContent value="input">{input === null ? null : <JsonValue label="Input" value={input} defaultOpen />}</TabsContent>
      <TabsContent value="logs"><StepLogs lines={logs} now={now} /></TabsContent>
      <TabsContent value="attempts"><ol aria-label="Attempts">{attempts.map((a) => <li key={a.attempt}>{attemptWords(a)} · {stepDuration(Math.max(0, (a.finishedAtMs ?? now) - a.startedAtMs))}</li>)}</ol></TabsContent>
    </Tabs>
  </section>;
}
