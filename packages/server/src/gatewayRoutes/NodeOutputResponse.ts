export type NodeOutputResponse = {
  status: "produced" | "pending" | "failed";
  row: Record<string, unknown> | null;
  schema: {
    fields: Array<{
      name: string;
      type:
        | "string"
        | "number"
        | "boolean"
        | "object"
        | "array"
        | "null"
        | "unknown";
      optional: boolean;
      nullable: boolean;
      description?: string;
      enum?: readonly unknown[];
    }>;
  } | null;
  partial?: Record<string, unknown> | null;
};
