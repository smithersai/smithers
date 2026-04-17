import type { FilePatch } from "./FilePatch.ts";

export type DiffBundle = {
	seq: number;
	baseRef: string;
	patches: FilePatch[];
};
