import type { XmlNode } from "@smithers/graph/XmlNode";
import { canonicalizeXml, parseXmlJson } from "@smithers/graph/utils/xml";
import type { FrameDelta } from "./FrameDelta";
import type { FrameDeltaOp } from "./FrameDeltaOp";
import type { JsonPath } from "./JsonPath";
import type { JsonPathSegment } from "./JsonPathSegment";

export function applyFrameDelta(
  previousXmlJson: string,
  delta: FrameDelta,
): string {
  const root = cloneValue(parseXmlJson(previousXmlJson)) as unknown;
  const next = applyOps(root, delta.ops);
  return canonicalizeXml(next as XmlNode | null);
}

function applyOps(root: unknown, ops: FrameDeltaOp[]): unknown {
  let current = root;
  for (const op of ops) {
    if (op.op === "set") {
      current = setAtPath(current, op.path, op.value);
      continue;
    }
    if (op.op === "insert") {
      current = insertAtPath(current, op.path, op.value);
      continue;
    }
    current = removeAtPath(current, op.path);
  }
  return current;
}

function setAtPath(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) {
    return cloneValue(value);
  }
  const { parent, key } = getParentAndKey(root, path);
  if (Array.isArray(parent)) {
    if (typeof key !== "number") {
      throw new Error("Invalid array set path");
    }
    parent[key] = cloneValue(value);
    return root;
  }
  if (!isRecord(parent) || typeof key !== "string") {
    throw new Error("Invalid object set path");
  }
  parent[key] = cloneValue(value);
  return root;
}

function insertAtPath(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) {
    return cloneValue(value);
  }
  const { parent, key } = getParentAndKey(root, path);
  if (!Array.isArray(parent) || typeof key !== "number") {
    throw new Error("Invalid insert path");
  }
  parent.splice(key, 0, cloneValue(value));
  return root;
}

function removeAtPath(root: unknown, path: JsonPath): unknown {
  if (path.length === 0) {
    return null;
  }
  const { parent, key } = getParentAndKey(root, path);
  if (Array.isArray(parent)) {
    if (typeof key !== "number") {
      throw new Error("Invalid array remove path");
    }
    parent.splice(key, 1);
    return root;
  }
  if (!isRecord(parent) || typeof key !== "string") {
    throw new Error("Invalid object remove path");
  }
  delete parent[key];
  return root;
}

function getParentAndKey(
  root: unknown,
  path: JsonPath,
): { parent: unknown; key: JsonPathSegment } {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i]!;
    if (typeof seg === "number") {
      if (!Array.isArray(cursor)) {
        throw new Error("Invalid numeric path segment");
      }
      cursor = cursor[seg];
      continue;
    }
    if (!isRecord(cursor)) {
      throw new Error("Invalid object path segment");
    }
    cursor = cursor[seg];
  }

  return { parent: cursor, key: path[path.length - 1]! };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
