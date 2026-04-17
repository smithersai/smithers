import type { OperationObject } from "./OperationObject.ts";
import type { ParameterObject } from "./ParameterObject.ts";
import type { RefObject } from "./RefObject.ts";

export type PathItem = {
	get?: OperationObject;
	post?: OperationObject;
	put?: OperationObject;
	delete?: OperationObject;
	patch?: OperationObject;
	parameters?: Array<ParameterObject | RefObject>;
};
