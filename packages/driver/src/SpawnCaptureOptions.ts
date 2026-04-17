export type SpawnCaptureOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  detached?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};
