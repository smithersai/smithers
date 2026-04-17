export type FilePatch = {
	path: string;
	operation: "add" | "modify" | "delete";
	diff: string;
	binaryContent?: string;
};
