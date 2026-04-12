import type { HttpMethod, ParameterObject } from "./types";
export declare function parseSpecText(text: string): any;
/**
 * Merge path-level and operation-level parameters. Operation-level wins
 * when there is a name+in collision.
 */
export declare function mergeParameters(pathLevel: ParameterObject[], opLevel: ParameterObject[]): ParameterObject[];
/**
 * Generate an operationId from method + path when one is not provided.
 * e.g. GET /pets/{petId} → get_pets_petId
 */
export declare function generateOperationId(method: HttpMethod, path: string): string;
