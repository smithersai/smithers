export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};
