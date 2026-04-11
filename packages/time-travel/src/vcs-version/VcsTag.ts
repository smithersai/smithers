export type VcsTag = {
  runId: string;
  frameNo: number;
  vcsType: string;
  vcsPointer: string;
  vcsRoot: string | null;
  jjOperationId: string | null;
  createdAtMs: number;
};
