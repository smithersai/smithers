import type { SignalRow } from "./SignalRow.ts";

export type SignalInsertRow = Omit<SignalRow, "seq">;
