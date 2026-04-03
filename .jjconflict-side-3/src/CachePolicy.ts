export type CachePolicy<Ctx = any> = {
  by?: (ctx: Ctx) => unknown;
  version?: string;
};
