export type OutputSchemaFieldType = "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";

export type OutputSchemaDescriptor = {
    fields: Array<{
        name: string;
        type: OutputSchemaFieldType;
        optional: boolean;
        nullable: boolean;
        description?: string;
        enum?: readonly unknown[];
    }>;
};

export type NodeOutputResponse = {
    status: "produced" | "pending" | "failed";
    row: Record<string, unknown> | null;
    schema: OutputSchemaDescriptor | null;
    partial?: Record<string, unknown> | null;
};
