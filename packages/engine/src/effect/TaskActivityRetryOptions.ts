export type TaskActivityRetryOptions = {
	times: number;
	while?: (error: unknown) => boolean;
};
