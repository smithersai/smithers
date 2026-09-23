/** @jsxImportSource react */
// A malformed timestamp omits its <time> instead of throwing
// `RangeError: Invalid time value` and taking down the whole render.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityItem } from "../src/agentic/ActivityTimeline";
import { Checkpoint, CheckpointMetadata } from "../src/approvals/Checkpoint";
import { CommitTimestamp } from "../src/artifacts/Commit";
import { ConversationCheckpoint } from "../src/chat/ConversationCheckpoint";
import { dateFromMs } from "../src/time/dateFromMs";

const INVALID = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1];
const VALID = Date.UTC(2026, 0, 2, 3, 4, 5);
const VALID_ISO = new Date(VALID).toISOString();

describe("dateFromMs", () => {
  test("accepts the representable range and rejects everything else", () => {
    expect(dateFromMs(VALID)?.toISOString()).toBe(VALID_ISO);
    expect(dateFromMs(8.64e15)?.getTime()).toBe(8.64e15);
    expect(dateFromMs(undefined)).toBeUndefined();
    for (const ms of INVALID) expect(dateFromMs(ms)).toBeUndefined();
  });
});

const renders: Record<string, (ms: number) => string> = {
  ActivityItem: (ms) => renderToStaticMarkup(<ActivityItem kind="tool" title="ran" timestampMs={ms} />),
  CheckpointMetadata: (ms) =>
    renderToStaticMarkup(
      <Checkpoint checkpoint={{ id: "cp", label: "cp", timestampMs: ms }}>
        <CheckpointMetadata />
      </Checkpoint>,
    ),
  CommitTimestamp: (ms) => renderToStaticMarkup(<CommitTimestamp timestampMs={ms} />),
  ConversationCheckpoint: (ms) => renderToStaticMarkup(<ConversationCheckpoint label="cp" timestampMs={ms} />),
};

describe.each(Object.entries(renders))("%s", (_name, render) => {
  test("renders a valid timestamp as <time dateTime>", () => {
    expect(render(VALID)).toContain(`dateTime="${VALID_ISO}"`);
  });

  test.each(INVALID)("omits the time for %p without throwing", (ms) => {
    const html = render(ms);
    expect(html).not.toContain("<time");
  });
});
