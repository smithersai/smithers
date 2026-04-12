import { z } from "zod";
import type { OpenApiSpec, ParameterObject, RequestBodyObject } from "./types";
/**
 * Build a single Zod object schema for an operation's input, combining:
 * - path parameters
 * - query parameters
 * - header parameters
 * - request body fields
 */
export declare function buildOperationSchema(parameters: ParameterObject[], requestBody: RequestBodyObject | undefined, spec: OpenApiSpec): z.ZodType;
