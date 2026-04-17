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
    getRootHostContext() {
        return {};
    },
    getChildHostContext() {
        return {};
    },
    /**
   * @param {unknown} instance
   */
    getPublicInstance(instance) {
        return instance;
    },
    /**
   * @param {string} type
   * @param {Record<string, unknown>} props
   */
    createInstance(type, props) {
        return createElement(type, props);
    },
    /**
   * @param {string} text
   */
    createTextInstance(text) {
        return { kind: "text", text };
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   */
    appendInitialChild(parent, child) {
        parent.children.push(child);
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   */
    appendChild(parent, child) {
        parent.children.push(child);
    },
    /**
   * @param {HostContainer} container
   * @param {HostNode} child
   */
    appendChildToContainer(container, child) {
        container.root = child;
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   */
    removeChild(parent, child) {
        const idx = parent.children.indexOf(child);
        if (idx >= 0)
            parent.children.splice(idx, 1);
    },
    /**
   * @param {HostContainer} container
   */
    removeChildFromContainer(container) {
        container.root = null;
    },
    /**
   * @param {MutableHostElement} parent
   * @param {HostNode} child
   * @param {HostNode} beforeChild
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
   */
    insertInContainerBefore(container, child, _beforeChild) {
        container.root = child;
    },
    /**
   * @param {MutableHostElement} _instance
   * @param {string} _type
   * @param {unknown} oldProps
   * @param {unknown} newProps
   */
    prepareUpdate(_instance, _type, oldProps, newProps) {
        if (oldProps === newProps)
            return null;
        return newProps;
    },
    /**
   * @param {MutableHostElement} instance
   * @param {unknown[]} ...args
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
   */
    commitTextUpdate(textInstance, _oldText, newText) {
        textInstance.text = newText;
    },
    finalizeInitialChildren() {
        return false;
    },
    prepareForCommit() {
        return null;
    },
    resetAfterCommit() { },
    shouldSetTextContent() {
        return false;
    },
    /**
   * @param {HostContainer} container
   */
    clearContainer(container) {
        container.root = null;
    },
    getCurrentEventPriority() {
        return 1;
    },
    shouldAttemptEagerTransition() {
        return false;
    },
    maySuspendCommit() {
        return false;
    },
    preloadInstance() { },
    startSuspendingCommit() { },
    suspendInstance() { },
    waitForCommitToBeReady() {
        return null;
    },
    resetFormInstance() { },
    detachDeletedInstance() { },
    /**
   * @param {"error" | "warn" | "info" | "log"} type
   * @param {unknown[]} args
   */
    bindToConsole(type, args) {
        return () => {
            const fn = console[type] ?? console.log;
            fn(...args);
        };
    },
    getCurrentUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * @param {number} priority
   */
    setCurrentUpdatePriority(priority) {
        currentUpdatePriority = priority;
    },
    resolveUpdatePriority() {
        return currentUpdatePriority;
    },
    /**
   * @param {(...args: unknown[]) => void} fn
   * @param {number} [delay]
   */
    scheduleTimeout(fn, delay) {
        return setTimeout(fn, delay ?? 0);
    },
    /**
   * @param {() => void} fn
   */
    scheduleMicrotask(fn) {
        queueMicrotask(fn);
    },
    /**
   * @param {ReturnType<typeof setTimeout>} id
   */
    cancelTimeout(id) {
        clearTimeout(id);
    },
    noTimeout: -1,
};
/** @type {any} */
const reconciler = Reconciler(hostConfig);
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
    /** @type {any} */
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
