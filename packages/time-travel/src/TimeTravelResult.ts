export type TimeTravelResult = {
  success: boolean;
  jjPointer?: string;
  vcsRestored: boolean;
  resetNodes: string[];
  error?: string;
};
