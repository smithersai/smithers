import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode";

export type SmithersErrorCode = KnownSmithersErrorCode | (string & {});
