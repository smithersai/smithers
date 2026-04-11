import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode.ts";

export type SmithersErrorCode = KnownSmithersErrorCode | (string & {});
