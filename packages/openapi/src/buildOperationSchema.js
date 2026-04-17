// ---------------------------------------------------------------------------
// Build a combined Zod schema from operation parameters + requestBody
// ---------------------------------------------------------------------------
import { z } from "zod";
import { isRef } from "./ref-resolver.js";
import { jsonSchemaToZod } from "./jsonSchemaToZod.js";

/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./ParameterObject.ts").ParameterObject} ParameterObject */
/** @typedef {import("./RequestBodyObject.ts").RequestBodyObject} RequestBodyObject */

/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 *
 * @param {ParameterObject[]} parameters
 * @param {RequestBodyObject | undefined} requestBody
 * @param {OpenApiSpec} spec
 * @returns {z.ZodType}
 */
export function buildOperationSchema(parameters, requestBody, spec) {
    const props = {};
    const requiredKeys = [];
    // Parameters (path, query, header)
    for (const param of parameters) {
        if (param.in === "cookie")
            continue; // skip cookies
        let paramSchema = jsonSchemaToZod(param.schema, spec);
        if (param.description && !(param.schema && !isRef(param.schema) && param.schema.description)) {
            paramSchema = paramSchema.describe(param.description);
        }
        if (!param.required) {
            paramSchema = paramSchema.optional();
        }
        else {
            requiredKeys.push(param.name);
        }
        props[param.name] = paramSchema;
    }
    // Request body
    if (requestBody) {
        const jsonContent = requestBody.content?.["application/json"];
        if (jsonContent?.schema) {
            const bodySchema = jsonSchemaToZod(jsonContent.schema, spec);
            // If the body schema is an object, merge its properties
            // into the top-level props under a "body" key
            if (requestBody.required) {
                props.body = bodySchema;
                requiredKeys.push("body");
            }
            else {
                props.body = bodySchema.optional();
            }
        }
    }
    if (Object.keys(props).length === 0) {
        return z.object({});
    }
    return z.object(props);
}
