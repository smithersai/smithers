/**
 * Converts a Zod v3 schema to JSON Schema format.
 * Used when smithers (zod v4) receives schemas from projects using zod v3.
 */
export function zodV3ToJsonSchema(schema: any): any {
  if (!schema?._def) return { type: "object" };

  const typeName = schema._def.typeName as string;

  if (typeName === "ZodObject") {
    const shape = schema._def.shape?.() ?? schema.shape ?? {};
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodV3ToJsonSchema(val);
      if (!isOptional(val)) required.push(key);
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };

  if (typeName === "ZodArray") {
    const items = schema._def.type ? zodV3ToJsonSchema(schema._def.type) : {};
    return { type: "array", items };
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: schema._def.values };
  }

  if (typeName === "ZodLiteral") {
    return { const: schema._def.value };
  }

  if (typeName === "ZodOptional") {
    return zodV3ToJsonSchema(schema._def.innerType);
  }

  if (typeName === "ZodDefault") {
    const inner = zodV3ToJsonSchema(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }

  if (typeName === "ZodNullable") {
    const inner = zodV3ToJsonSchema(schema._def.innerType);
    return { ...inner, nullable: true };
  }

  if (typeName === "ZodUnion") {
    return { anyOf: schema._def.options.map((o: any) => zodV3ToJsonSchema(o)) };
  }

  // Fallback
  return {};
}

function isOptional(schema: any): boolean {
  const tn = schema?._def?.typeName;
  if (tn === "ZodOptional") return true;
  if (tn === "ZodDefault") return true;
  return false;
}
