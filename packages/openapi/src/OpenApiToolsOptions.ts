import type { OpenApiAuth } from "./OpenApiAuth.ts";

export type OpenApiToolsOptions = {
	baseUrl?: string;
	headers?: Record<string, string>;
	auth?: OpenApiAuth;
	include?: string[];
	exclude?: string[];
	namePrefix?: string;
};
