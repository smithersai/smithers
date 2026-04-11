// ---------------------------------------------------------------------------
// Build a combined Zod schema from operation parameters + requestBody
// ---------------------------------------------------------------------------

import { z } from "zod";
import { isRef } from "./ref-resolver";
import type { OpenApiSpec, ParameterObject, RequestBodyObject } from "./types";
import { jsonSchemaToZod } from "./jsonSchemaToZod";

/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 */
export function buildOperationSchema(
  parameters: ParameterObject[],
  requestBody: RequestBodyObject | undefined,
  spec: OpenApiSpec,
): z.ZodType {
  const props: Record<string, z.ZodType> = {};
  const requiredKeys: string[] = [];

  // Parameters (path, query, header)
  for (const param of parameters) {
    if (param.in === "cookie") continue; // skip cookies
    let paramSchema = jsonSchemaToZod(param.schema, spec);
    if (param.description && !(param.schema && !isRef(param.schema) && param.schema.description)) {
      paramSchema = paramSchema.describe(param.description);
    }
    if (!param.required) {
      paramSchema = paramSchema.optional();
    } else {
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
      } else {
        props.body = bodySchema.optional();
      }
    }
  }

  if (Object.keys(props).length === 0) {
    return z.object({});
  }

  return z.object(props);
}
