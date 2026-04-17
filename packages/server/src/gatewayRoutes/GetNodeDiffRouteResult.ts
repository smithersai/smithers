export type GetNodeDiffRouteResult =
  | {
      ok: true;
      payload: any;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };
