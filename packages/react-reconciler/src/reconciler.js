import Reconciler from "react-reconciler";
import { installRDTHook } from "bippy";
import { resolveExtractGraph } from "./core-peer.js";
/** @typedef {import("@smithers/graph/types").ExtractGraph} ExtractGraph */
/** @typedef {import("@smithers/graph/types").ExtractOptions} ExtractOptions */
/** @typedef {import("./HostContainer.ts").HostContainer} HostContainer */
/** @typedef {import("@smithers/graph/types").HostElement & { props: Record<string, string>; rawProps: Record<string, unknown>; children: HostNode[] }} MutableHostElement */
/** @typedef {import("@smithers/graph/types").HostNode} HostNode */
/** @typedef {import("@smithers/graph/types").HostText & { text: string }} MutableHostText */
/** @typedef {import("react").default} React */
/** @typedef {import("./SmithersRendererOptions.ts").SmithersRendererOptions} SmithersRendererOptions */
/** @typedef {import("@smithers/graph/types").WorkflowGraph} WorkflowGraph */
/**
 * Minimal local shape for a react-reconciler instance. `@types/react-reconciler`
 * is not installed here, so we describe only the methods we call.
 * @typedef {{
 *   createContainer: (
 *     rootContainer: unknown,
 *     tag: number,
 *     hydrationCallbacks: unknown,
 *     isStrictMode: boolean,
 *     concurrentUpdatesByDefaultOverride: unknown,
 *     identifierPrefix: string,
 *     onUncaughtError: unknown,
 *     onCaughtError: unknown,
 *     onRecoverableError: unknown,
 *     transitionCallbacks: unknown,
 *   ) => unknown;
 *   updateContainerSync: (element: unknown, container: unknown, parentComponent: unknown, callback: () => void) => void;
 *   flushSyncWork: () => void;
 *   injectIntoDevTools: (devtools: unknown) => void;
 *   defaultOnUncaughtError: unknown;
 *   defaultOnCaughtError: unknown;
 *   defaultOnRecoverableError: unknown;
 * }} ReconcilerInstance */

/**
 * @param {string} type
 * @param {Record<string, unknown>} props
 * @returns {MutableHostElement}
 */
function createElement(type, props) {
    const { children: _children, ...rest } = props || {};
    const stringProps = {};
    for (const [key, value] of Object.entries(rest)) {
        if (value === undefined || typeof value === "function")
            continue;
        if (key.startsWith("__"))
            continue;
        if (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean") {
            stringProps[key] = String(value);
        }
    }
    return {
        kind: "element",
        tag: type,
        props: stringProps,
        rawProps: props ?? {},
        children: [],
    };
}
let currentUpdatePriority = 1;
const hostConfig = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,
    supportsMicrotasks: true,
    /**
   * @returns {Record<string, unknown>}
   */
    getRootHostContext() {
        return {};
    },
    /**
   * @returns {Record<string, unknown>}
   */
    getChildHostContext() {
        return {};
    },
    /**
   * @param {unknown} instance
   * @returns {unknown}
   */
    getPublicInstance(instance) {
        return instance;
    },
    /**
   * @param {string} type
   * @param {Record<string, unknown>} props
   * @returns {MutableHostElement}
   */
    createInstance(type, props) {
        return createElement(type, props);
    },
    /**
   * @param {string} text
   * @returns {MutableHostText}
   */
    createTextInstance(text) {
        return { kind: "text", text };
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    appendInitialChild(parent, child) {
        parent.children.push(child);
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    appendChild(parent, child) {
        parent.children.push(child);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} child
   * @returns {void}
   */
    appendChildToContainer(container, child) {
        container.root = child;
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @returns {void}
   */
    removeChild(parent, child) {
        const idx = parent.children.indexOf(child);
        if (idx >= 0)
            parent.children.splice(idx, 1);
    },
    /**
   * @param {HostContainer} container
   * @returns {void}
   */
    removeChildFromContainer(container) {
        container.root = null;
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @param {HostNode} beforeChild
   * @returns {void}
   */
    insertBefore(parent, child, beforeChild) {
        const idx = parent.children.indexOf(beforeChild);
        if (idx >= 0)
            parent.children.splice(idx, 0, child);
        else
            parent.children.push(child);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} child
   * @param {HostNode} _beforeChild
   * @returns {void}
   */
    insertInContainerBefore(container, child, _beforeChild) {
        container.root = child;
    },
    /**
   * @param {MutableHostElement} _instance
   * @param {string} _type
   * @param {unknown} oldProps
   * @param {unknown} newProps
   * @returns {unknown}
   */
    prepareUpdate(_instance, _type, oldProps, newProps) {
        if (oldProps === newProps)
            return null;
        return newProps;
    },
    /**
   * @param {MutableHostElement} instance
   * @param {unknown[]} args
   * @returns {void}
   */
    commitUpdate(instance, ...args) {
        let nextProps = null;
        const first = args[0];
        const second = args[1];
        if (typeof second === "string" && first && typeof first === "object") {
            nextProps = first;
        }
        else if (typeof first === "string") {
            const maybeNewProps = args[2];
            if (maybeNewProps && typeof maybeNewProps === "object") {
                nextProps = maybeNewProps;
            }
        }
        else if (first && typeof first === "object") {
            nextProps = first;
        }
        if (!nextProps)
            return;
        const next = createElement(instance.tag, nextProps);
        instance.props = next.props;
        instance.rawProps = next.rawProps;
    },
    /**
   * @param {MutableHostText} textInstance
   * @param {string} _oldText
   * @param {string} newText
   * @returns {void}
   */
    commitTextUpdate(textInstance, _oldText, newText) {
        textInstance.text = newText;
    },
    /**
   * @returns {boolean}
   */
    finalizeInitialChildren() {
        return false;
    },
    /**
   * @returns {null}
   */
    prepareForCommit() {
        return null;
    },
    /**
   * @returns {void}
   */
    resetAfterCommit() { },
    /**
   * @returns {boolean}
   */
    shouldSetTextContent() {
        return false;
    },
    /**
   * @param {HostContainer} container
   * @returns {void}
   */
    clearContainer(container) {
        container.root = null;
    },
    /**
   * @returns {number}
   */
    getCurrentEventPriority() {
        return 1;
    },
    /**
   * @returns {boolean}
   */
    shouldAttemptEagerTransition() {
        return false;
    },
    /**
   * @returns {boolean}
   */
    maySuspendCommit() {
        return false;
    },
    /**
   * @returns {void}
   */
    preloadInstance() { },
    /**
   * @returns {void}
   */
    startSuspendingCommit() { },
    /**
   * @returns {void}
   */
    suspendInstance() { },
    /**
   * @returns {null}
   */
    waitForCommitToBeReady() {
        return null;
    },
    /**
   * @returns {void}
   */
    resetFormInstance() { },
    /**
   * @returns {void}
   */
    detachDeletedInstance() { },
    /**
   * @param {"error" | "warn" | "info" | "log"} type
   * @param {unknown[]} args
   * @returns {() => void}
   */
    bindToConsole(type, args) {
        return () => {
            const fn = console[type] ?? console.log;
            fn(...args);
        };
    },
    /**
   * @returns {number}
   */
    getCurrentUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * @param {number} priority
   * @returns {void}
   */
    setCurrentUpdatePriority(priority) {
        currentUpdatePriority = priority;
    },
    /**
   * @returns {number}
   */
    resolveUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * @param {(...args: unknown[]) => void} fn
   * @param {number} [delay]
   * @returns {ReturnType<typeof setTimeout>}
   */
    scheduleTimeout(fn, delay) {
        return setTimeout(fn, delay ?? 0);
    },
    /**
   * @param {() => void} fn
   * @returns {void}
   */
    scheduleMicrotask(fn) {
        queueMicrotask(fn);
    },
    /**
   * @param {ReturnType<typeof setTimeout>} id
   * @returns {void}
   */
    cancelTimeout(id) {
        clearTimeout(id);
    },
    noTimeout: -1,
};
/** @type {ReconcilerInstance} */
const reconciler = /** @type {ReconcilerInstance} */ (Reconciler(hostConfig));
const hookHost = globalThis;
if (!hookHost.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    installRDTHook();
}
reconciler.injectIntoDevTools({
    bundleType: typeof process !== "undefined" && process.env.NODE_ENV === "production" ? 0 : 1,
    version: "0.0.0",
    rendererPackageName: "@smithers/core-react",
    findFiberByHostInstance: () => null,
});
export class SmithersRenderer {
    /** @type {HostContainer} */
    container;
    /** @type {unknown} */
    root;
    /** @type {ExtractGraph | undefined} */
    extractGraph;
    /**
   * @param {SmithersRendererOptions} [options]
   */
    constructor(options = {}) {
        this.extractGraph = options.extractGraph;
        this.container = { root: null };
        this.root = reconciler.createContainer(this.container, 0, null, false, null, "", reconciler.defaultOnUncaughtError, reconciler.defaultOnCaughtError, reconciler.defaultOnRecoverableError, null);
    }
    /**
   * @param {React.ReactElement} element
   * @param {ExtractOptions} [opts]
   * @returns {Promise<WorkflowGraph>}
   */
    async render(element, opts) {
        reconciler.updateContainerSync(element, this.root, null, () => { });
        reconciler.flushSyncWork();
        const extractGraph = this.extractGraph ?? (await resolveExtractGraph());
        return extractGraph(this.container.root, opts);
    }
    /**
   * @returns {HostNode | null}
   */
    getRoot() {
        return this.container.root;
    }
}
