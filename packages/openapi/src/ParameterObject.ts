import type { RefObject } from "./RefObject.ts";
import type { SchemaObject } from "./SchemaObject.ts";

export type ParameterObject = {
	name: string;
	in: "query" | "header" | "path" | "cookie";
	description?: string;
	required?: boolean;
	schema?: SchemaObject | RefObject;
	deprecated?: boolean;
};
