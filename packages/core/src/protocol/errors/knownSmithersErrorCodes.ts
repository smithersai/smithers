import { smithersErrorDefinitions } from "./smithersErrorDefinitions";
import type { KnownSmithersErrorCode } from "./KnownSmithersErrorCode";

export const knownSmithersErrorCodes = Object.keys(
  smithersErrorDefinitions,
) as KnownSmithersErrorCode[];
