import type { DiffBundle } from "@smithers-orchestrator/engine/effect/DiffBundle";
import type { DiffSummary } from "./DiffSummary";

export type GetNodeDiffStatPayload = {
  seq: number;
  baseRef: string;
  summary: DiffSummary;
};

export type GetNodeDiffRoutePayload = DiffBundle | GetNodeDiffStatPayload;

export type GetNodeDiffRouteResult =
  | {
      ok: true;
      payload: GetNodeDiffRoutePayload;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
