// @smithers-type-exports-begin
/** @typedef {import("./HttpMethod.ts").HttpMethod} HttpMethod */
/** @typedef {import("./MediaTypeObject.ts").MediaTypeObject} MediaTypeObject */
/** @typedef {import("./OpenApiAuth.ts").OpenApiAuth} OpenApiAuth */
/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./OpenApiToolsOptions.ts").OpenApiToolsOptions} OpenApiToolsOptions */
/** @typedef {import("./OperationObject.ts").OperationObject} OperationObject */
/** @typedef {import("./ParameterObject.ts").ParameterObject} ParameterObject */
/** @typedef {import("./ParsedOperation.ts").ParsedOperation} ParsedOperation */
/** @typedef {import("./PathItem.ts").PathItem} PathItem */
/** @typedef {import("./RefObject.ts").RefObject} RefObject */
/** @typedef {import("./RequestBodyObject.ts").RequestBodyObject} RequestBodyObject */
/** @typedef {import("./SchemaObject.ts").SchemaObject} SchemaObject */
// @smithers-type-exports-end

// ---------------------------------------------------------------------------
// OpenAPI types — minimal subset of OpenAPI 3.0+ needed for tool generation
// ---------------------------------------------------------------------------
/** @type {HttpMethod[]} */
export const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];
