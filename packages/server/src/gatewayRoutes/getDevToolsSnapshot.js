import { SmithersDevToolsCore, snapshotSerialize } from "@smithers-orchestrator/devtools";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNode} DevToolsNode */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("@smithers-orchestrator/protocol/devtools").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("@smithers-orchestrator/devtools/snapshotSerializer").SnapshotSerializerWarning} SnapshotSerializerWarning */

export const DEVTOOLS_RUN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const DEVTOOLS_MAX_FRAME_NO = 2_147_483_647;
export const DEVTOOLS_TREE_MAX_DEPTH = 256;

const DEVTOOLS_TAG_TO_TYPE = {
    "smithers:workflow": "workflow",
    "smithers:task": "task",
    "smithers:sequence": "sequence",
    "smithers:parallel": "parallel",
    "smithers:merge-queue": "merge-queue",
    "smithers:branch": "branch",
    "smithers:ralph": "loop",
    "smithers:worktree": "worktree",
    "smithers:approval": "approval",
    "smithers:timer": "timer",
    "smithers:subflow": "subflow",
    "smithers:wait-for-event": "wait-for-event",
    "smithers:saga": "saga",
    "smithers:try-catch-finally": "try-catch",
};

export class DevToolsRouteError extends Error {
    /**
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
    constructor(code, message, hint) {
        super(message);
        this.name = "DevToolsRouteError";
        this.code = code;
        this.hint = hint;
    }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function asObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const DEVTOOLS_EMPTY_ROOT_ID = 0;

/**
 * @returns {DevToolsNode}
 */
export function emptyDevToolsRoot() {
    return {
        id: DEVTOOLS_EMPTY_ROOT_ID,
        type: "workflow",
        name: "(empty)",
        props: {},
        children: [],
        depth: 0,
    };
}

/**
 * @param {string} runId
 * @returns {string}
 */
export function validateRunId(runId) {
    if (!DEVTOOLS_RUN_ID_PATTERN.test(runId)) {
        throw new DevToolsRouteError("InvalidRunId", "runId must match /^[a-z0-9_-]{1,64}$/.");
    }
    return runId;
}

/**
 * @param {unknown} frameNo
 * @param {number} latestFrameNo
 * @returns {number}
 */
export function validateRequestedFrameNo(frameNo, latestFrameNo) {
    if (!Number.isInteger(frameNo) || frameNo < 0 || frameNo > DEVTOOLS_MAX_FRAME_NO || frameNo > latestFrameNo) {
        throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be between 0 and ${latestFrameNo}.`);
    }
    return frameNo;
}

/**
 * @param {Record<string, unknown>} props
 * @returns {DevToolsNode["task"] | undefined}
 */
function extractTaskInfo(props) {
    const rawNodeId = typeof props.id === "string"
        ? props.id
        : typeof props.nodeId === "string"
            ? props.nodeId
            : null;
    if (!rawNodeId) {
        return undefined;
    }
    let nodeId = rawNodeId;
    let iteration = typeof props.iteration === "number" ? props.iteration : undefined;
    const match = rawNodeId.match(/^(.*)::(\d+)$/);
    if (match) {
        nodeId = match[1];
        if (iteration === undefined) {
            iteration = Number(match[2]);
        }
    }
    const kind = props.__smithersKind === "agent" || props.kind === "agent"
        ? "agent"
        : props.__smithersKind === "compute" || props.kind === "compute"
            ? "compute"
            : "static";
    return {
        nodeId,
        kind,
        agent: typeof props.agent === "string" ? props.agent : undefined,
        label: typeof props.label === "string" ? props.label : undefined,
        outputTableName: typeof props.outputTableName === "string"
            ? props.outputTableName
            : typeof props.output === "string"
                ? props.output
                : undefined,
        iteration: typeof iteration === "number" && Number.isFinite(iteration)
            ? iteration
            : undefined,
    };
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parsePropValue(raw) {
    if (raw === "true") {
        return true;
    }
    if (raw === "false") {
        return false;
    }
    if (raw === "null") {
        return null;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
        const parsedNumber = Number(raw);
        if (Number.isFinite(parsedNumber)) {
            return parsedNumber;
        }
    }
    if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
        try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        }
    }
    return raw;
}

/**
 * Derive a stable 31-bit numeric id from a node identity string.
 *
 * The identity must be deterministic across frames for the same logical node
 * so that diff/apply round-trips do not mistake a reorder for a removal + re-add
 * or reuse an id across unrelated nodes.
 *
 * @param {string} identity
 * @returns {number}
 */
function stableNodeId(identity) {
    // FNV-1a 32-bit hash, masked to 31-bit positive so JSON numbers are safe.
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index += 1) {
        hash ^= identity.charCodeAt(index);
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash & 0x7fffffff;
}

/**
 * @param {Record<string, unknown>} element
 * @returns {string}
 */
function nodeIdentityFragment(element) {
    const tag = typeof element.tag === "string" ? element.tag : "unknown";
    const rawProps = asObject(element.props) ? element.props : {};
    const taskId = typeof rawProps.id === "string"
        ? rawProps.id
        : typeof rawProps.nodeId === "string"
            ? rawProps.nodeId
            : "";
    if (taskId) {
        return `${tag}#${taskId}`;
    }
    return tag;
}

/**
 * @param {unknown} xml
 * @param {(warning: SnapshotSerializerWarning) => void} [onWarning]
 * @returns {DevToolsNode}
 */
export function parseXmlToDevToolsRoot(xml, onWarning) {
    if (!asObject(xml) || xml.kind !== "element") {
        return emptyDevToolsRoot();
    }
    /** @type {Set<number>} */
    const usedIds = new Set();
    /**
   * @param {string} identity
   * @returns {number}
   */
    const assignId = (identity) => {
        let candidate = identity;
        let id = stableNodeId(candidate);
        // Collisions across unrelated paths: rehash with a suffix until unique.
        let salt = 0;
        while (usedIds.has(id) && salt < 1024) {
            salt += 1;
            candidate = `${identity}\u0000${salt}`;
            id = stableNodeId(candidate);
        }
        usedIds.add(id);
        return id;
    };
    /**
   * @param {Record<string, unknown>} element
   * @param {number} depth
   * @param {string} path
   * @returns {DevToolsNode}
   */
    const makeNode = (element, depth, path) => {
        const tag = typeof element.tag === "string" ? element.tag : "unknown";
        const nodeType = DEVTOOLS_TAG_TO_TYPE[tag] ?? "unknown";
        const rawProps = asObject(element.props) ? element.props : {};
        /** @type {Record<string, unknown>} */
        const serializedProps = {};
        for (const [key, value] of Object.entries(rawProps)) {
            const parsedValue = typeof value === "string" ? parsePropValue(value) : value;
            serializedProps[key] = snapshotSerialize(parsedValue, {
                onWarning,
            });
        }
        const displayName = nodeType === "workflow" && typeof serializedProps.name === "string"
            ? serializedProps.name
            : tag.startsWith("smithers:")
                ? tag.slice("smithers:".length)
                : tag;
        return {
            id: assignId(path),
            type: /** @type {DevToolsNodeType} */ (nodeType),
            name: displayName || "unknown",
            props: serializedProps,
            task: nodeType === "task" ? extractTaskInfo(serializedProps) : undefined,
            children: [],
            depth,
        };
    };
    const rootIdentity = nodeIdentityFragment(xml);
    const root = makeNode(xml, 0, rootIdentity);
    /** @type {Array<{ xml: Record<string, unknown>; node: DevToolsNode; depth: number; path: string }>} */
    const stack = [{ xml, node: root, depth: 0, path: rootIdentity }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        const rawChildren = Array.isArray(current.xml.children)
            ? current.xml.children
            : [];
        /** @type {Array<{ xml: Record<string, unknown>; node: DevToolsNode; depth: number; path: string }>} */
        const childPairs = [];
        /** @type {Map<string, number>} */
        const siblingCounts = new Map();
        for (const child of rawChildren) {
            if (!asObject(child) || child.kind !== "element") {
                continue;
            }
            const childDepth = current.depth + 1;
            if (childDepth > DEVTOOLS_TREE_MAX_DEPTH) {
                const markerPath = `${current.path}/__maxdepth__${current.node.children.length}`;
                current.node.children.push({
                    id: assignId(markerPath),
                    type: "unknown",
                    name: "[MaxDepth]",
                    props: { value: "[MaxDepth]" },
                    children: [],
                    depth: childDepth,
                });
                continue;
            }
            const fragment = nodeIdentityFragment(child);
            const occurrence = siblingCounts.get(fragment) ?? 0;
            siblingCounts.set(fragment, occurrence + 1);
            const childPath = occurrence === 0
                ? `${current.path}/${fragment}`
                : `${current.path}/${fragment}[${occurrence}]`;
            const childNode = makeNode(child, childDepth, childPath);
            current.node.children.push(childNode);
            childPairs.push({ xml: child, node: childNode, depth: childDepth, path: childPath });
        }
        for (let index = childPairs.length - 1; index >= 0; index -= 1) {
            stack.push(childPairs[index]);
        }
    }
    return root;
}

/**
 * @param {{
 *   runId: string;
 *   frameNo: number;
 *   xmlJson: string;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {DevToolsSnapshot}
 */
export function snapshotFromFrameRow(input) {
    let xml = null;
    try {
        xml = JSON.parse(input.xmlJson);
    }
    catch {
        xml = null;
    }
    const root = parseXmlToDevToolsRoot(xml, input.onWarning);
    // Keep parity with existing devtools snapshot capture semantics.
    const core = new SmithersDevToolsCore();
    core.captureSnapshot(root);
    return {
        version: 1,
        runId: input.runId,
        frameNo: input.frameNo,
        seq: input.frameNo,
        root,
    };
}

/**
 * Validate a frameNo input before any DB or reconciler call so that oversized
 * or malformed numeric inputs never reach the adapter.
 *
 * @param {unknown} frameNo
 * @returns {void}
 */
export function validateFrameNoInput(frameNo) {
    if (frameNo === undefined) {
        return;
    }
    if (!Number.isInteger(frameNo) || frameNo < 0 || frameNo > DEVTOOLS_MAX_FRAME_NO) {
        throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be an integer between 0 and ${DEVTOOLS_MAX_FRAME_NO}.`);
    }
}

/**
 * Validate a fromSeq input before any DB or reconciler call.
 *
 * @param {unknown} fromSeq
 * @returns {void}
 */
export function validateFromSeqInput(fromSeq) {
    if (fromSeq === undefined) {
        return;
    }
    if (!Number.isInteger(fromSeq) || fromSeq < 0 || fromSeq > Number.MAX_SAFE_INTEGER) {
        throw new DevToolsRouteError("SeqOutOfRange", "fromSeq must be a non-negative integer.");
    }
}

/**
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   frameNo?: number;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 * }} input
 * @returns {Promise<DevToolsSnapshot>}
 */
export async function getDevToolsSnapshotRoute(input) {
    const runId = validateRunId(input.runId);
    validateFrameNoInput(input.frameNo);
    const run = await input.adapter.getRun(runId);
    if (!run) {
        throw new DevToolsRouteError("RunNotFound", `Run not found: ${runId}`);
    }
    const runState = await computeRunStateFromRow(input.adapter, run).catch(
        () => undefined,
    );
    const latestFrame = await input.adapter.getLastFrame(runId);
    if (!latestFrame) {
        // Zero-frame runs: only frameNo === undefined or 0 is permitted. Any
        // higher value is out of range because there is no frame 1 to return.
        if (input.frameNo !== undefined && input.frameNo !== 0) {
            throw new DevToolsRouteError("FrameOutOfRange", `frameNo must be 0 for runs with no frames (got ${input.frameNo}).`);
        }
        return {
            version: 1,
            runId,
            frameNo: 0,
            seq: 0,
            root: emptyDevToolsRoot(),
            ...(runState ? { runState } : {}),
        };
    }
    let requestedFrameNo = latestFrame.frameNo;
    if (input.frameNo !== undefined) {
        requestedFrameNo = validateRequestedFrameNo(input.frameNo, latestFrame.frameNo);
    }
    const frame = requestedFrameNo === latestFrame.frameNo
        ? latestFrame
        : (await input.adapter.listFrames(runId, Math.max(latestFrame.frameNo - requestedFrameNo + 1, 50))).find((entry) => entry.frameNo === requestedFrameNo);
    if (!frame) {
        throw new DevToolsRouteError("FrameOutOfRange", `Frame ${requestedFrameNo} is not available for run ${runId}.`);
    }
    const snapshot = snapshotFromFrameRow({
        runId,
        frameNo: requestedFrameNo,
        xmlJson: String(frame.xmlJson ?? "null"),
        onWarning: input.onWarning,
    });
    return runState ? { ...snapshot, runState } : snapshot;
}
