import type { HttpMethod } from "./HttpMethod.ts";
import type { ParameterObject } from "./ParameterObject.ts";
import type { RequestBodyObject } from "./RequestBodyObject.ts";

export type ParsedOperation = {
	operationId: string;
	method: HttpMethod;
	path: string;
	summary: string;
	description: string;
	parameters: ParameterObject[];
	requestBody?: RequestBodyObject;
	deprecated: boolean;
};
