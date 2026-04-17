export type SqlMessageStorageEventHistoryQuery = {
	afterSeq?: number;
	limit?: number;
	nodeId?: string;
	types?: readonly string[];
	sinceTimestampMs?: number;
};
