import type { RefObject } from "./RefObject.ts";

export type SchemaObject = {
	type?: string;
	format?: string;
	description?: string;
	properties?: Record<string, SchemaObject | RefObject>;
	required?: string[];
	items?: SchemaObject | RefObject;
	enum?: unknown[];
	default?: unknown;
	nullable?: boolean;
	oneOf?: Array<SchemaObject | RefObject>;
	anyOf?: Array<SchemaObject | RefObject>;
	allOf?: Array<SchemaObject | RefObject>;
	additionalProperties?: boolean | SchemaObject | RefObject;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	$ref?: string;
};
