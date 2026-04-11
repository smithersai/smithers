import type { XmlNode } from "@smithers/graph/XmlNode";
import { canonicalizeXml, parseXmlJson } from "@smithers/graph/utils/xml";

export type FrameEncoding = "full" | "delta" | "keyframe";

export const FRAME_KEYFRAME_INTERVAL = 50;
const FRAME_DELTA_VERSION = 1;

type JsonPathSegment = string | number;
export type JsonPath = JsonPathSegment[];

export type FrameDeltaOp =
  | {
      op: "set";
      path: JsonPath;
      value: unknown;
      nodeId?: string;
    }
  | {
      op: "insert";
      path: JsonPath;
      value: unknown;
      nodeId?: string;
    }
  | {
      op: "remove";
      path: JsonPath;
      nodeId?: string;
    };

export type FrameDelta = {
  version: typeof FRAME_DELTA_VERSION;
  ops: FrameDeltaOp[];
};

export function normalizeFrameEncoding(value: unknown): FrameEncoding {
  if (value === "delta") return "delta";
  if (value === "keyframe") return "keyframe";
  return "full";
}

export function parseFrameDelta(deltaJson: string): FrameDelta {
  const parsed = JSON.parse(deltaJson);
  if (!isRecord(parsed)) {
    throw new Error("Invalid frame delta payload (not an object)");
  }
  if (parsed.version !== FRAME_DELTA_VERSION) {
    throw new Error(`Unsupported frame delta version: ${String(parsed.version)}`);
  }
  if (!Array.isArray(parsed.ops)) {
    throw new Error("Invalid frame delta payload (missing ops array)");
  }
  return parsed as FrameDelta;
}

export function serializeFrameDelta(delta: FrameDelta): string {
  return JSON.stringify(delta);
}

export function encodeFrameDelta(
  previousXmlJson: string,
  nextXmlJson: string,
): FrameDelta {
  const prev = parseXmlJson(previousXmlJson) as unknown;
  const next = parseXmlJson(nextXmlJson) as unknown;
  const ops: FrameDeltaOp[] = [];
  diffValues(prev, next, [], ops, null);
  return {
    version: FRAME_DELTA_VERSION,
    ops,
  };
}

export function applyFrameDelta(
  previousXmlJson: string,
  delta: FrameDelta,
): string {
  const root = cloneValue(parseXmlJson(previousXmlJson)) as unknown;
  const next = applyOps(root, delta.ops);
  return canonicalizeXml(next as XmlNode | null);
}

export function applyFrameDeltaJson(
  previousXmlJson: string,
  deltaJson: string,
): string {
  return applyFrameDelta(previousXmlJson, parseFrameDelta(deltaJson));
}

function diffValues(
  prev: unknown,
  next: unknown,
  path: JsonPath,
  ops: FrameDeltaOp[],
  currentNodeId: string | null,
): void {
  if (deepEqual(prev, next)) return;

  if (prev === undefined && next !== undefined) {
    pushSet(ops, path, next, currentNodeId);
    return;
  }
  if (next === undefined) {
    pushRemove(ops, path, currentNodeId);
    return;
  }

  const prevIsObj = isRecord(prev);
  const nextIsObj = isRecord(next);

  if (Array.isArray(prev) && Array.isArray(next)) {
    diffArrays(prev, next, path, ops, currentNodeId);
    return;
  }

  if (prevIsObj && nextIsObj) {
    const nodeId = inferNodeId(next, inferNodeId(prev, currentNodeId));
    diffObjects(prev, next, path, ops, nodeId);
    return;
  }

  pushSet(ops, path, next, currentNodeId);
}

function diffObjects(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: JsonPath,
  ops: FrameDeltaOp[],
  currentNodeId: string | null,
): void {
  const keys = Array.from(new Set([...Object.keys(prev), ...Object.keys(next)])).sort();

  for (const key of keys) {
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, key);
    const hasNext = Object.prototype.hasOwnProperty.call(next, key);
    const nextPath = [...path, key];

    if (!hasNext && hasPrev) {
      pushRemove(ops, nextPath, currentNodeId);
      continue;
    }

    if (hasNext && !hasPrev) {
      pushSet(ops, nextPath, next[key], currentNodeId);
      continue;
    }

    diffValues(prev[key], next[key], nextPath, ops, currentNodeId);
  }
}

function diffArrays(
  prev: unknown[],
  next: unknown[],
  path: JsonPath,
  ops: FrameDeltaOp[],
  currentNodeId: string | null,
): void {
  let start = 0;
  while (start < prev.length && start < next.length && deepEqual(prev[start], next[start])) {
    start += 1;
  }

  let prevEnd = prev.length - 1;
  let nextEnd = next.length - 1;
  while (prevEnd >= start && nextEnd >= start && deepEqual(prev[prevEnd], next[nextEnd])) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const prevCount = prevEnd - start + 1;
  const nextCount = nextEnd - start + 1;

  if (prevCount <= 0 && nextCount <= 0) {
    return;
  }

  if (prevCount <= 0) {
    for (let i = 0; i < nextCount; i += 1) {
      pushInsert(ops, [...path, start + i], next[start + i], currentNodeId);
    }
    return;
  }

  if (nextCount <= 0) {
    for (let i = prevEnd; i >= start; i -= 1) {
      pushRemove(ops, [...path, i], currentNodeId);
    }
    return;
  }

  if (prevCount === nextCount) {
    for (let i = 0; i < prevCount; i += 1) {
      const prevValue = prev[start + i];
      const nextValue = next[start + i];
      const childNodeId = inferNodeId(nextValue, inferNodeId(prevValue, currentNodeId));
      diffValues(prevValue, nextValue, [...path, start + i], ops, childNodeId);
    }
    return;
  }

  for (let i = prevEnd; i >= start; i -= 1) {
    pushRemove(ops, [...path, i], currentNodeId);
  }
  for (let i = 0; i < nextCount; i += 1) {
    pushInsert(ops, [...path, start + i], next[start + i], currentNodeId);
  }
}

function pushSet(
  ops: FrameDeltaOp[],
  path: JsonPath,
  value: unknown,
  nodeId: string | null,
) {
  const op: FrameDeltaOp = {
    op: "set",
    path,
    value: cloneValue(value),
    ...(nodeId ? { nodeId } : {}),
  };
  ops.push(op);
}

function pushInsert(
  ops: FrameDeltaOp[],
  path: JsonPath,
  value: unknown,
  nodeId: string | null,
) {
  const op: FrameDeltaOp = {
    op: "insert",
    path,
    value: cloneValue(value),
    ...(nodeId ? { nodeId } : {}),
  };
  ops.push(op);
}

function pushRemove(ops: FrameDeltaOp[], path: JsonPath, nodeId: string | null) {
  const op: FrameDeltaOp = {
    op: "remove",
    path,
    ...(nodeId ? { nodeId } : {}),
  };
  ops.push(op);
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

function inferNodeId(
  value: unknown,
  fallback: string | null,
): string | null {
  if (!isRecord(value)) return fallback;
  if (value.kind !== "element") return fallback;
  const props = value.props;
  if (!isRecord(props)) return fallback;
  const id = props.id;
  return typeof id === "string" && id.length > 0 ? id : fallback;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i += 1) {
      if (keysA[i] !== keysB[i]) return false;
      const key = keysA[i]!;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
