import type { RefObject } from "./RefObject.ts";
import type { SchemaObject } from "./SchemaObject.ts";

export type MediaTypeObject = {
	schema?: SchemaObject | RefObject;
};
