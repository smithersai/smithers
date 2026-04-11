import { smithersErrorDefinitions } from "./smithersErrorDefinitions.ts";
import type { SmithersErrorCode } from "./SmithersErrorCode.ts";
import type { SmithersErrorDefinition } from "./SmithersErrorDefinition.ts";
import { isKnownSmithersErrorCode } from "./isKnownSmithersErrorCode.ts";

export function getSmithersErrorDefinition(
  code: SmithersErrorCode,
): SmithersErrorDefinition | undefined {
  if (!isKnownSmithersErrorCode(code)) return undefined;
  return smithersErrorDefinitions[code];
}
