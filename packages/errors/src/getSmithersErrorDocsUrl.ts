import { ERROR_REFERENCE_URL } from "./ERROR_REFERENCE_URL.ts";
import type { SmithersErrorCode } from "./SmithersErrorCode.ts";

export function getSmithersErrorDocsUrl(_code: SmithersErrorCode): string {
  return ERROR_REFERENCE_URL;
}
