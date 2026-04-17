export type TimerProps = {
	id: string;
	/**
	 * Relative duration (examples: "500ms", "1s", "30m", "1h", "7d").
	 */
	duration?: string;
	/**
	 * Absolute fire time (ISO timestamp or Date).
	 */
	until?: string | Date;
	/**
	 * Recurring timer syntax is reserved for phase 2 and is not supported yet.
	 */
	every?: string;
	skipIf?: boolean;
	dependsOn?: string[];
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
};
