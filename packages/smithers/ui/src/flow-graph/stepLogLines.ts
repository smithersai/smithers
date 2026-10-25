/**
 * A step's log as lines a person reads like a CI log: time, level, message,
 * then `key=value` fields. Framework-free, so a terminal reads it the same.
 *
 * Each value is what the host hands over: a `telemetry.log` journal payload
 * (`@smthrs/journal`'s `TelemetryLog.Log`) or plain printed text. A payload
 * that doesn't read as a log record is shown as its text.
 */
import type { JsonValueData } from "../json-value/jsonValueText";

/** One line of a step's log. */
export type StepLogLine =
  | {
    readonly kind: "record";
    /** When it was logged, in epoch milliseconds, or null when the record names no readable time. */
    readonly at: number | null;
    /** `INFO`, `WARN`, `ERROR`, `DEBUG`, `TRACE` or `FATAL`. */
    readonly level: string;
    readonly message: string;
    /** The record's own annotations and a structured message's members, engine attribution left out. */
    readonly fields: ReadonlyArray<readonly [key: string, value: string]>;
    /** The failure the record carried, if any. */
    readonly error: string | null;
    readonly attempt: number | null;
  }
  | { readonly kind: "attempt"; readonly attempt: number }
  | { readonly kind: "text"; readonly text: string };

/** Annotations the engine adds to attribute a record to its step, which the step's own view already says. */
const attribution = new Set(["runId", "stepKeyDigest", "stepKey", "attempt", "tier"]);

const levels = new Set(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const compact = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

/** A field value as it reads after `=`: quoted only when it holds a space, a quote or an `=`. */
const fieldValue = (value: unknown): string => {
  if (typeof value === "string") return /[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return compact(value);
};

/** A failure as one phrase: its tag or name, then its message. */
const failure = (value: unknown): string => {
  const fields = record(value);
  if (fields === undefined) return typeof value === "string" ? value : compact(value);
  const name = typeof fields._tag === "string" ? fields._tag : typeof fields.name === "string" ? fields.name : undefined;
  const message = typeof fields.message === "string" && fields.message.length > 0 ? fields.message : undefined;
  if (name !== undefined || message !== undefined) return [name, message].filter((part) => part !== undefined).join(": ");
  return compact(value);
};

const causeText = (cause: unknown): string | null => {
  const reasons = record(cause)?.reasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return reasons.map((reason) => {
    const fields = record(reason);
    if (fields?._tag === "Fail") return failure(fields.error);
    if (fields?._tag === "Die") return failure(fields.defect);
    return "Interrupted";
  }).join("; ");
};

/** A record from one payload, or undefined when the payload isn't one. */
const recordLine = (payload: unknown): Extract<StepLogLine, { kind: "record" }> | undefined => {
  const log = record(payload);
  if (log === undefined || log.version !== 1 || typeof log.level !== "string" || !levels.has(log.level)) return undefined;
  const annotations = record(log.annotations);
  if (annotations === undefined) return undefined;
  const parts = Array.isArray(log.message) ? log.message : log.message === undefined ? [] : [log.message];
  const words: Array<string> = [];
  const fields: Array<readonly [string, string]> = [];
  for (const part of parts) {
    const members = record(part);
    if (members !== undefined) {
      for (const [key, value] of Object.entries(members)) fields.push([key, fieldValue(value)]);
    } else {
      words.push(typeof part === "string" ? part : fieldValue(part));
    }
  }
  for (const [key, value] of Object.entries(annotations)) {
    if (!attribution.has(key)) fields.push([key, fieldValue(value)]);
  }
  const at = typeof log.timestamp === "string" ? Date.parse(log.timestamp) : Number.NaN;
  return {
    kind: "record",
    at: Number.isNaN(at) ? null : at,
    level: log.level.toUpperCase(),
    message: words.join(" "),
    fields,
    error: causeText(log.cause),
    attempt: typeof annotations.attempt === "number" ? annotations.attempt : null,
  };
};

const parse = (value: JsonValueData): unknown => {
  if (value.clipped) return undefined;
  try {
    return JSON.parse(value.text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The lines a step's log shows, in the order given. When the records name more
 * than one attempt, each attempt's records start with an `attempt` line.
 */
export const stepLogLines = (values: ReadonlyArray<JsonValueData>): ReadonlyArray<StepLogLine> => {
  const lines = values.map((value): StepLogLine =>
    recordLine(parse(value)) ?? { kind: "text", text: value.clipped ? `${value.text}…` : value.text }
  );
  const attempts = new Set(lines.flatMap((line) => line.kind === "record" && line.attempt !== null ? [line.attempt] : []));
  if (attempts.size < 2) return lines;
  const out: Array<StepLogLine> = [];
  let current: number | null = null;
  for (const line of lines) {
    if (line.kind === "record" && line.attempt !== null && line.attempt !== current) {
      current = line.attempt;
      out.push({ kind: "attempt", attempt: line.attempt });
    }
    out.push(line);
  }
  return out;
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A record's time as it reads beside its line: the clock, with the day when it isn't `now`'s day. */
export const stepLogTime = (at: number, now: number): string => {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? clock.format(at) : `${day.format(at)} ${clock.format(at)}`;
};
