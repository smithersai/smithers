export type WatchTreeOptions = {
	/** Patterns to ignore (directory basenames) */
	ignore?: string[];
	/** Debounce interval in ms (default: 100) */
	debounceMs?: number;
};
