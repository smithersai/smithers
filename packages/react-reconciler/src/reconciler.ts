import type React from "react";
import Reconciler from "react-reconciler";
import { installRDTHook } from "bippy";
import type {
  ExtractGraph,
  ExtractOptions,
  HostNode,
  WorkflowGraph,
} from "@smithers/graph/types";
import { resolveExtractGraph } from "./core-peer";

export type HostContainer = {
  root: HostNode | null;
};

type MutableHostElement = {
  kind: "element";
  tag: string;
  props: Record<string, string>;
  rawProps: Record<string, unknown>;
  children: HostNode[];
};

type MutableHostText = {
  kind: "text";
  text: string;
};

export type SmithersRendererOptions = {
  extractGraph?: ExtractGraph;
};

function createElement(
  type: string,
  props: Record<string, unknown>,
): MutableHostElement {
  const { children: _children, ...rest } = props || {};
  const stringProps: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || typeof value === "function") continue;
    if (key.startsWith("__")) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
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

const hostConfig: any = {
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
  getPublicInstance(instance: unknown) {
    return instance;
  },
  createInstance(type: string, props: Record<string, unknown>) {
    return createElement(type, props);
  },
  createTextInstance(text: string) {
    return { kind: "text", text } satisfies MutableHostText;
  },
  appendInitialChild(parent: MutableHostElement, child: HostNode) {
    parent.children.push(child);
  },
  appendChild(parent: MutableHostElement, child: HostNode) {
    parent.children.push(child);
  },
  appendChildToContainer(container: HostContainer, child: HostNode) {
    container.root = child;
  },
  removeChild(parent: MutableHostElement, child: HostNode) {
    const idx = parent.children.indexOf(child);
    if (idx >= 0) parent.children.splice(idx, 1);
  },
  removeChildFromContainer(container: HostContainer) {
    container.root = null;
  },
  insertBefore(parent: MutableHostElement, child: HostNode, beforeChild: HostNode) {
    const idx = parent.children.indexOf(beforeChild);
    if (idx >= 0) parent.children.splice(idx, 0, child);
    else parent.children.push(child);
  },
  insertInContainerBefore(
    container: HostContainer,
    child: HostNode,
    _beforeChild: HostNode,
  ) {
    container.root = child;
  },
  prepareUpdate(
    _instance: MutableHostElement,
    _type: string,
    oldProps: unknown,
    newProps: unknown,
  ) {
    if (oldProps === newProps) return null;
    return newProps;
  },
  commitUpdate(instance: MutableHostElement, ...args: unknown[]) {
    let nextProps: Record<string, unknown> | null = null;
    const first = args[0];
    const second = args[1];
    if (typeof second === "string" && first && typeof first === "object") {
      nextProps = first as Record<string, unknown>;
    } else if (typeof first === "string") {
      const maybeNewProps = args[2];
      if (maybeNewProps && typeof maybeNewProps === "object") {
        nextProps = maybeNewProps as Record<string, unknown>;
      }
    } else if (first && typeof first === "object") {
      nextProps = first as Record<string, unknown>;
    }

    if (!nextProps) return;
    const next = createElement(instance.tag, nextProps);
    instance.props = next.props;
    instance.rawProps = next.rawProps;
  },
  commitTextUpdate(
    textInstance: MutableHostText,
    _oldText: string,
    newText: string,
  ) {
    textInstance.text = newText;
  },
  finalizeInitialChildren() {
    return false;
  },
  prepareForCommit() {
    return null;
  },
  resetAfterCommit() {},
  shouldSetTextContent() {
    return false;
  },
  clearContainer(container: HostContainer) {
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
  preloadInstance() {},
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null;
  },
  resetFormInstance() {},
  detachDeletedInstance() {},
  bindToConsole(type: "error" | "warn" | "info" | "log", args: unknown[]) {
    return () => {
      const fn = (console as any)[type] ?? console.log;
      fn(...args);
    };
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  setCurrentUpdatePriority(priority: number) {
    currentUpdatePriority = priority;
  },
  resolveUpdatePriority() {
    return currentUpdatePriority;
  },
  scheduleTimeout(fn: (...args: unknown[]) => void, delay?: number) {
    return setTimeout(fn, delay ?? 0);
  },
  scheduleMicrotask(fn: () => void) {
    queueMicrotask(fn);
  },
  cancelTimeout(id: ReturnType<typeof setTimeout>) {
    clearTimeout(id);
  },
  noTimeout: -1,
};

const reconciler = Reconciler(hostConfig);

const hookHost = globalThis as typeof globalThis & {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown;
};

if (!hookHost.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  installRDTHook();
}

(reconciler as any).injectIntoDevTools({
  bundleType: typeof process !== "undefined" && process.env.NODE_ENV === "production" ? 0 : 1,
  version: "0.0.0",
  rendererPackageName: "@smithers/core-react",
  findFiberByHostInstance: () => null,
});

export class SmithersRenderer {
  private readonly container: HostContainer;
  private readonly root: unknown;
  private readonly extractGraph?: ExtractGraph;

  constructor(options: SmithersRendererOptions = {}) {
    this.extractGraph = options.extractGraph;
    this.container = { root: null };
    this.root = (reconciler as any).createContainer(
      this.container,
      0,
      null,
      false,
      null,
      "",
      (reconciler as any).defaultOnUncaughtError,
      (reconciler as any).defaultOnCaughtError,
      (reconciler as any).defaultOnRecoverableError,
      null,
    );
  }

  async render(
    element: React.ReactElement,
    opts?: ExtractOptions,
  ): Promise<WorkflowGraph> {
    (reconciler as any).updateContainerSync(element, this.root, null, () => {});
    (reconciler as any).flushSyncWork();
    const extractGraph = this.extractGraph ?? (await resolveExtractGraph());
    return extractGraph(this.container.root, opts);
  }

  getRoot(): HostNode | null {
    return this.container.root;
  }
}
