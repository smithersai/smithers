import type { smithersErrorDefinitions } from "./smithersErrorDefinitions.ts";

export type KnownSmithersErrorCode = keyof typeof smithersErrorDefinitions;
