export type DiffSummary = {
  filesChanged: number;
  added: number;
  removed: number;
  files: Array<{ path: string; added: number; removed: number }>;
};
