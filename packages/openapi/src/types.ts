export type OpenApiSpec = {
    openapi: string;
    info: {
        title: string;
        version: string;
        description?: string;
    };
    servers?: Array<{
        url: string;
        description?: string;
    }>;
    paths: Record<string, PathItem>;
    components?: {
        schemas?: Record<string, SchemaObject>;
        parameters?: Record<string, ParameterObject>;
        requestBodies?: Record<string, RequestBodyObject>;
    };
};
export type PathItem = {
    get?: OperationObject;
    post?: OperationObject;
    put?: OperationObject;
    delete?: OperationObject;
    patch?: OperationObject;
    parameters?: Array<ParameterObject | RefObject>;
};
export type OperationObject = {
    operationId?: string;
    summary?: string;
    description?: string;
    parameters?: Array<ParameterObject | RefObject>;
    requestBody?: RequestBodyObject | RefObject;
    responses?: Record<string, unknown>;
    tags?: string[];
    deprecated?: boolean;
};
export type ParameterObject = {
    name: string;
    in: "query" | "header" | "path" | "cookie";
    description?: string;
    required?: boolean;
    schema?: SchemaObject | RefObject;
    deprecated?: boolean;
};
export type RequestBodyObject = {
    description?: string;
    required?: boolean;
    content: Record<string, MediaTypeObject>;
};
export type MediaTypeObject = {
    schema?: SchemaObject | RefObject;
};
export type SchemaObject = {
    type?: string;
    format?: string;
    description?: string;
    properties?: Record<string, SchemaObject | RefObject>;
    required?: string[];
    items?: SchemaObject | RefObject;
    enum?: unknown[];
    default?: unknown;
    nullable?: boolean;
    oneOf?: Array<SchemaObject | RefObject>;
    anyOf?: Array<SchemaObject | RefObject>;
    allOf?: Array<SchemaObject | RefObject>;
    additionalProperties?: boolean | SchemaObject | RefObject;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    $ref?: string;
};
export type RefObject = {
    $ref: string;
};
export type HttpMethod = "get" | "post" | "put" | "delete" | "patch";
export declare const HTTP_METHODS: HttpMethod[];
export type ParsedOperation = {
    operationId: string;
    method: HttpMethod;
    path: string;
    summary: string;
    description: string;
    parameters: ParameterObject[];
    requestBody?: RequestBodyObject;
    deprecated: boolean;
};
export type OpenApiAuth = {
    type: "bearer";
    token: string;
} | {
    type: "basic";
    username: string;
    password: string;
} | {
    type: "apiKey";
    name: string;
    value: string;
    in: "header" | "query";
};
export type OpenApiToolsOptions = {
    baseUrl?: string;
    headers?: Record<string, string>;
    auth?: OpenApiAuth;
    include?: string[];
    exclude?: string[];
    namePrefix?: string;
};
