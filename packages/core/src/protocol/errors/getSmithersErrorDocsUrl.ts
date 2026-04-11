import { ERROR_REFERENCE_URL } from "./ERROR_REFERENCE_URL";
import type { SmithersErrorCode } from "./SmithersErrorCode";

export function getSmithersErrorDocsUrl(_code: SmithersErrorCode): string {
  return ERROR_REFERENCE_URL;
}
