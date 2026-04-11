export type CachePolicy<Ctx = any> = {
  by?: (ctx: Ctx) => unknown;
  version?: string;
  key?: string;
  ttlMs?: number;
  scope?: "run" | "workflow" | "global";
  [key: string]: unknown;
};
