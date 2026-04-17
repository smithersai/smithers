export type HelloResponse = {
  protocol: number;
  features: string[];
  policy: {
    heartbeatMs: number;
  };
  auth: {
    sessionToken: string;
    role: string;
    scopes: string[];
    userId: string | null;
  };
  snapshot: {
    runs: any[];
    approvals: any[];
    stateVersion: number;
  };
};
