import type { HumanRequestKind } from "./HumanRequestKind.ts";
import type { HumanRequestStatus } from "./HumanRequestStatus.ts";

export type HumanRequestRow = {
  readonly requestId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly kind: HumanRequestKind;
  readonly status: HumanRequestStatus;
  readonly prompt: string;
  readonly schemaJson?: string | null;
  readonly optionsJson?: string | null;
  readonly responseJson?: string | null;
  readonly requestedAtMs: number;
  readonly answeredAtMs?: number | null;
  readonly answeredBy?: string | null;
  readonly timeoutAtMs?: number | null;
};
