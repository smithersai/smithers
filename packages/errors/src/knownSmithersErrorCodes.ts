import { smithersErrorDefinitions } from "./smithersErrorDefinitions.ts";
import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode.ts";

export const knownSmithersErrorCodes = Object.keys(
  smithersErrorDefinitions,
) as KnownSmithersErrorCode[];
