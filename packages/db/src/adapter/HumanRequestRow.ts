import type {
  HumanRequestKind,
  HumanRequestStatus,
} from "@smithers/durables";

export type HumanRequestRow = {
  requestId: string;
  runId: string;
  nodeId: string;
  iteration: number;
  kind: HumanRequestKind;
  status: HumanRequestStatus;
  prompt: string;
  schemaJson: string | null;
  optionsJson: string | null;
  responseJson: string | null;
  requestedAtMs: number;
  answeredAtMs: number | null;
  answeredBy: string | null;
  timeoutAtMs: number | null;
};
