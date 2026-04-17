export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq: number;
  stateVersion: number;
};
