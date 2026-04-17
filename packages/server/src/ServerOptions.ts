export type ServerOptions = {
  port?: number;
  db?: unknown;
  authToken?: string;
  maxBodyBytes?: number;
  rootDir?: string;
  allowNetwork?: boolean;
};
