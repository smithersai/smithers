
/** @typedef {import("zod").ZodObject<any>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {import("zod").ZodObject<any>} schema
 * @returns {string}
 */
export function zodSchemaToJsonExample(schema) {
    const example = {};
    for (const [key, field] of Object.entries(schema.shape)) {
        example[key] = zodFieldToExample(field);
    }
    return JSON.stringify(example, null, 2);
}
/**
 * @param {ZodTypeAny} field
 * @returns {any}
 */
function zodFieldToExample(field) {
    const anyField = field;
    const zod = anyField._zod;
    const def = zod?.def;
    if (!def)
        return "value";
    const description = anyField.description ??
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
            if (inner && typeof inner === "object")
                return [zodFieldToExample(inner)];
            return ["value"];
        }
        case "enum": {
            if (Array.isArray(def.values))
                return def.values[0] ?? "enum";
            if (def.entries && typeof def.entries === "object") {
                const keys = Object.keys(def.entries);
                return keys[0] ?? "enum";
            }
            return "enum";
        }
        case "object": {
            const shape = field.shape;
            if (!shape)
                return {};
            const obj = {};
            for (const [key, value] of Object.entries(shape)) {
                obj[key] = zodFieldToExample(value);
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
