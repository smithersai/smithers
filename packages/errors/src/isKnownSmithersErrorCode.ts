import { smithersErrorDefinitions } from "./smithersErrorDefinitions.ts";
import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode.ts";

export function isKnownSmithersErrorCode(
  code: string,
): code is KnownSmithersErrorCode {
  return code in smithersErrorDefinitions;
}
