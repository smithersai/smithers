import type { MediaTypeObject } from "./MediaTypeObject.ts";

export type RequestBodyObject = {
	description?: string;
	required?: boolean;
	content: Record<string, MediaTypeObject>;
};
