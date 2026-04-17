export type RewindLockHandle = {
  runId: string;
  release: () => boolean;
};
