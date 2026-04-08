import type { z } from "zod";

export function zodSchemaToJsonExample(schema: z.ZodObject<any>): string {
  const example: Record<string, any> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    example[key] = zodFieldToExample(field as z.ZodTypeAny);
  }
  return JSON.stringify(example, null, 2);
}

function zodFieldToExample(field: z.ZodTypeAny): any {
  const anyField = field as any;
  const zod = anyField._zod;
  const def = zod?.def;
  if (!def) return "value";

  const description =
    anyField.description ??
    anyField._def?.description ??
    zod?.bag?.description ??
    def.description ??
    "";
  const typeName = def.type;

  switch (typeName) {
    case "string":
      return description || "string";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array": {
      const inner = def.element;
      if (inner && typeof inner === "object") return [zodFieldToExample(inner)];
      return ["value"];
    }
    case "enum": {
      if (Array.isArray(def.values)) return def.values[0] ?? "enum";
      if (def.entries && typeof def.entries === "object") {
        const keys = Object.keys(def.entries);
        return keys[0] ?? "enum";
      }
      return "enum";
    }
    case "object": {
      const shape = (field as z.ZodObject<any>).shape;
      if (!shape) return {};
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(shape)) {
        obj[k] = zodFieldToExample(v as z.ZodTypeAny);
      }
      return obj;
    }
    case "nullable":
      return zodFieldToExample(def.innerType);
    case "optional":
      return zodFieldToExample(def.innerType);
    default:
      return description || "value";
  }
}
