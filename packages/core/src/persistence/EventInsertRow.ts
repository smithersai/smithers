import type { EventRow } from "./EventRow.ts";

export type EventInsertRow = Omit<EventRow, "seq">;
