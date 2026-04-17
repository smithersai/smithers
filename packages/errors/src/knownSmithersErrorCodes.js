import { smithersErrorDefinitions } from "./smithersErrorDefinitions.js";

/** @typedef {import("./KnownSmithersErrorCode.ts").KnownSmithersErrorCode} KnownSmithersErrorCode */

export const knownSmithersErrorCodes = /** @type {KnownSmithersErrorCode[]} */ (
  Object.keys(smithersErrorDefinitions)
);
