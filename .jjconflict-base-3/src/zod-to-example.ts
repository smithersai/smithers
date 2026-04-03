import type { z } from "zod";

export function zodSchemaToJsonExample(schema: z.ZodObject<any>): string {
  const example: Record<string, any> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    example[key] = zodFieldToExample(field as z.ZodTypeAny);
  }
  return JSON.stringify(example, null, 2);
}

function zodFieldToExample(field: z.ZodTypeAny): any {
  const def = (field as any)._def;
  const description = def?.description ?? (field as any).description ?? "";

  const typeName = def?.typeName ?? def?.type;

  switch (typeName) {
    case "ZodString":
    case "string":
      return description || "string";
    case "ZodNumber":
    case "number":
      return 0;
    case "ZodBoolean":
    case "boolean":
      return false;
    case "ZodArray":
    case "array": {
      const inner = def.element ?? def.type;
      if (inner && typeof inner === "object") return [zodFieldToExample(inner)];
      return ["value"];
    }
    case "ZodEnum":
    case "enum": {
      if (Array.isArray(def.values)) return def.values[0] ?? "enum";
      if (def.entries && typeof def.entries === "object") {
        const keys = Object.keys(def.entries);
        return keys[0] ?? "enum";
      }
      return "enum";
    }
    case "ZodObject":
    case "object": {
      const shape = (field as z.ZodObject<any>).shape ?? def.shape;
      if (!shape) return {};
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(shape)) {
        obj[k] = zodFieldToExample(v as z.ZodTypeAny);
      }
      return obj;
    }
    case "ZodNullable":
    case "nullable":
      return zodFieldToExample(def.inner ?? def.innerType);
    case "ZodOptional":
    case "optional":
      return zodFieldToExample(def.inner ?? def.innerType);
    default:
      return description || "value";
  }
}
