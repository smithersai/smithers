import type { ParameterObject } from "./ParameterObject.ts";
import type { RefObject } from "./RefObject.ts";
import type { RequestBodyObject } from "./RequestBodyObject.ts";

export type OperationObject = {
	operationId?: string;
	summary?: string;
	description?: string;
	parameters?: Array<ParameterObject | RefObject>;
	requestBody?: RequestBodyObject | RefObject;
	responses?: Record<string, unknown>;
	tags?: string[];
	deprecated?: boolean;
};
