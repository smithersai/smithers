import { smithersErrorDefinitions } from "./smithersErrorDefinitions";
import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode";

export function isKnownSmithersErrorCode(
  code: string,
): code is KnownSmithersErrorCode {
  return code in smithersErrorDefinitions;
}
