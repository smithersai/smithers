import type { smithersErrorDefinitions } from "./smithersErrorDefinitions";

export type KnownSmithersErrorCode = keyof typeof smithersErrorDefinitions;
