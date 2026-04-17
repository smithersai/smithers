export type SafeParser = {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error?: unknown };
};
