import type { JsonPath } from "./JsonPath";

export type FrameDeltaOp =
  | {
      op: "set";
      path: JsonPath;
      value: unknown;
      nodeId?: string;
    }
  | {
      op: "insert";
      path: JsonPath;
      value: unknown;
      nodeId?: string;
    }
  | {
      op: "remove";
      path: JsonPath;
      nodeId?: string;
    };
