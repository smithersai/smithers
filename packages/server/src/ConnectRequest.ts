export type ConnectRequest = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
  };
  auth?:
    | {
        token: string;
      }
    | {
        password: string;
      };
  subscribe?: string[];
};
