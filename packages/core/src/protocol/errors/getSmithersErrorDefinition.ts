import { smithersErrorDefinitions } from "./smithersErrorDefinitions";
import type { SmithersErrorCode } from "./SmithersErrorCode";
import type { SmithersErrorDefinition } from "./SmithersErrorDefinition";
import { isKnownSmithersErrorCode } from "./isKnownSmithersErrorCode";

export function getSmithersErrorDefinition(
  code: SmithersErrorCode,
): SmithersErrorDefinition | undefined {
  if (!isKnownSmithersErrorCode(code)) return undefined;
  return smithersErrorDefinitions[code];
}
