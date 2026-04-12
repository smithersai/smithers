import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphMeta.ts").RalphMeta} RalphMeta */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("@smithers/graph").XmlNode} XmlNode */

/**
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
function stablePathId(prefix, path) {
    if (path.length === 0)
        return `${prefix}:root`;
    return `${prefix}:${path.join(".")}`;
}
/**
 * @param {unknown} explicitId
 * @param {string} prefix
 * @param {readonly number[]} path
 * @returns {string}
 */
function resolveStableId(explicitId, prefix, path) {
    if (typeof explicitId === "string" && explicitId.trim().length > 0) {
        return explicitId;
    }
    return stablePathId(prefix, path);
}
/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function parseBool(value) {
    if (!value)
        return false;
    return value === "true" || value === "1";
}
/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parseNum(value, fallback) {
    const parsed = value ? Number(value) : NaN;
    return !Number.isNaN(parsed) ? parsed : fallback;
}
/**
 * @param {readonly { readonly ralphId: string; readonly iteration: number }[]} loopStack
 * @returns {string}
 */
function buildLoopScope(loopStack) {
    if (loopStack.length === 0)
        return "";
    return `@@${loopStack.map((entry) => `${entry.ralphId}=${entry.iteration}`).join(",")}`;
}
/**
 * @param {XmlNode | null} xml
 * @param {RalphStateMap} [ralphState]
 * @returns {{ readonly plan: PlanNode | null; readonly ralphs: readonly RalphMeta[]; }}
 */
export function buildPlanTree(xml, ralphState) {
    if (!xml)
        return { plan: null, ralphs: [] };
    const ralphs = [];
    const seenRalph = new Set();
    /**
   * @param {XmlNode} node
   * @param {{ readonly path: readonly number[]; readonly parentIsRalph: boolean; readonly loopStack: readonly { readonly ralphId: string; readonly iteration: number }[]; }} ctx
   * @returns {PlanNode | null}
   */
    function walk(node, ctx) {
        if (node.kind === "text")
            return null;
        const tag = node.tag;
        if (ctx.parentIsRalph && tag === "smithers:ralph") {
            throw new SmithersError("NESTED_LOOP", "Nested <Ralph> is not supported.");
        }
        let loopStack = ctx.loopStack;
        let scopedRalphId;
        if (tag === "smithers:ralph") {
            const logicalId = resolveStableId(node.props.id, "ralph", ctx.path);
            const scope = buildLoopScope(loopStack);
            scopedRalphId = logicalId + scope;
            const currentIter = ralphState?.get(scopedRalphId)?.iteration ?? 0;
            loopStack = [...loopStack, { ralphId: logicalId, iteration: currentIter }];
        }
        if (tag === "smithers:saga") {
            const id = resolveStableId(node.props.id, "saga", ctx.path);
            const onFailure = node.props.onFailure ??
                "compensate";
            const actionChildren = [];
            const compensationChildren = [];
            let specialIndex = 0;
            for (const child of node.children) {
                const nextPath = child.kind === "element" ? [...ctx.path, specialIndex++] : ctx.path;
                if (child.kind !== "element")
                    continue;
                if (child.tag === "smithers:saga-actions") {
                    let nestedIndex = 0;
                    for (const nested of child.children) {
                        const nestedPath = nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
                        const built = walk(nested, {
                            path: nestedPath,
                            parentIsRalph: false,
                            loopStack,
                        });
                        if (built)
                            actionChildren.push(built);
                    }
                    continue;
                }
                if (child.tag === "smithers:saga-compensations") {
                    let nestedIndex = 0;
                    for (const nested of child.children) {
                        const nestedPath = nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
                        const built = walk(nested, {
                            path: nestedPath,
                            parentIsRalph: false,
                            loopStack,
                        });
                        if (built)
                            compensationChildren.push(built);
                    }
                    continue;
                }
                const built = walk(child, {
                    path: nextPath,
                    parentIsRalph: false,
                    loopStack,
                });
                if (built)
                    actionChildren.push(built);
            }
            return {
                kind: "saga",
                id,
                actionChildren,
                compensationChildren,
                onFailure,
            };
        }
        if (tag === "smithers:try-catch-finally") {
            const id = resolveStableId(node.props.id, "tcf", ctx.path);
            const tryChildren = [];
            const catchChildren = [];
            const finallyChildren = [];
            let specialIndex = 0;
            for (const child of node.children) {
                const nextPath = child.kind === "element" ? [...ctx.path, specialIndex++] : ctx.path;
                if (child.kind !== "element")
                    continue;
                const target = child.tag === "smithers:tcf-catch"
                    ? catchChildren
                    : child.tag === "smithers:tcf-finally"
                        ? finallyChildren
                        : tryChildren;
                if (child.tag === "smithers:tcf-try" ||
                    child.tag === "smithers:tcf-catch" ||
                    child.tag === "smithers:tcf-finally") {
                    let nestedIndex = 0;
                    for (const nested of child.children) {
                        const nestedPath = nested.kind === "element" ? [...nextPath, nestedIndex++] : nextPath;
                        const built = walk(nested, {
                            path: nestedPath,
                            parentIsRalph: false,
                            loopStack,
                        });
                        if (built)
                            target.push(built);
                    }
                    continue;
                }
                const built = walk(child, {
                    path: nextPath,
                    parentIsRalph: false,
                    loopStack,
                });
                if (built)
                    tryChildren.push(built);
            }
            return {
                kind: "try-catch-finally",
                id,
                tryChildren,
                catchChildren,
                finallyChildren,
            };
        }
        const children = [];
        let elementIndex = 0;
        const isRalph = tag === "smithers:ralph";
        for (const child of node.children) {
            const nextPath = child.kind === "element" ? [...ctx.path, elementIndex++] : ctx.path;
            const built = walk(child, {
                path: nextPath,
                parentIsRalph: isRalph,
                loopStack,
            });
            if (built)
                children.push(built);
        }
        if (tag === "smithers:task") {
            const logicalId = node.props.id;
            if (!logicalId)
                return null;
            const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
            return { kind: "task", nodeId: logicalId + ancestorScope };
        }
        if (tag === "smithers:workflow" || tag === "smithers:sequence") {
            return { kind: "sequence", children };
        }
        if (tag === "smithers:parallel" || tag === "smithers:merge-queue") {
            return { kind: "parallel", children };
        }
        if (tag === "smithers:worktree") {
            return { kind: "group", children };
        }
        if (tag === "smithers:subflow") {
            const mode = node.props.mode ?? "childRun";
            if (mode === "inline") {
                return { kind: "sequence", children };
            }
            const logicalId = node.props.id;
            if (!logicalId)
                return null;
            const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
            return { kind: "task", nodeId: logicalId + ancestorScope };
        }
        if (tag === "smithers:sandbox" ||
            tag === "smithers:wait-for-event" ||
            tag === "smithers:timer") {
            const logicalId = node.props.id;
            if (!logicalId)
                return null;
            const ancestorScope = loopStack.length > 1 ? buildLoopScope(loopStack.slice(0, -1)) : "";
            return { kind: "task", nodeId: logicalId + ancestorScope };
        }
        if (tag === "smithers:continue-as-new") {
            return { kind: "continue-as-new", stateJson: node.props.stateJson };
        }
        if (tag === "smithers:ralph") {
            const id = scopedRalphId;
            if (seenRalph.has(id)) {
                throw new SmithersError("DUPLICATE_ID", `Duplicate Ralph id detected: ${id}`, { kind: "ralph", id });
            }
            seenRalph.add(id);
            const parsedContinueAsNewEvery = Math.floor(parseNum(node.props.continueAsNewEvery, 0));
            const continueAsNewEvery = Number.isFinite(parsedContinueAsNewEvery) && parsedContinueAsNewEvery > 0
                ? parsedContinueAsNewEvery
                : undefined;
            const meta = {
                id,
                until: parseBool(node.props.until),
                maxIterations: parseNum(node.props.maxIterations, 5),
                onMaxReached: node.props.onMaxReached ?? "return-last",
                continueAsNewEvery,
            };
            ralphs.push(meta);
            return {
                kind: "ralph",
                id,
                children,
                until: meta.until,
                maxIterations: meta.maxIterations,
                onMaxReached: meta.onMaxReached,
                continueAsNewEvery,
            };
        }
        return { kind: "group", children };
    }
    const plan = walk(xml, { path: [], parentIsRalph: false, loopStack: [] });
    return { plan, ralphs };
}
