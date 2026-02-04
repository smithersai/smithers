import Reconciler from "react-reconciler";
import type React from "react";
import { extractFromHost, type HostNode, type HostElement, type HostText, type ExtractOptions } from "./extract";

export type HostContainer = {
  root: HostNode | null;
};

function createElement(type: string, props: Record<string, any>): HostElement {
  const { children: _children, ...rest } = props || {};
  const stringProps: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || typeof value === "function") continue;
    if (key.startsWith("__")) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      stringProps[key] = String(value);
    }
  }
  return { kind: "element", tag: type, props: stringProps, rawProps: props ?? {}, children: [] };
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
  getPublicInstance(instance: any) {
    return instance;
  },
  createInstance(type: string, props: any) {
    return createElement(type, props);
  },
  createTextInstance(text: string) {
    const node: HostText = { kind: "text", text };
    return node;
  },
  appendInitialChild(parent: HostElement, child: HostNode) {
    parent.children.push(child);
  },
  appendChild(parent: HostElement, child: HostNode) {
    parent.children.push(child);
  },
  appendChildToContainer(container: HostContainer, child: HostNode) {
    container.root = child;
  },
  removeChild(parent: HostElement, child: HostNode) {
    const idx = parent.children.indexOf(child);
    if (idx >= 0) parent.children.splice(idx, 1);
  },
  removeChildFromContainer(container: HostContainer) {
    container.root = null;
  },
  insertBefore(parent: HostElement, child: HostNode, beforeChild: HostNode) {
    const idx = parent.children.indexOf(beforeChild);
    if (idx >= 0) parent.children.splice(idx, 0, child);
    else parent.children.push(child);
  },
  insertInContainerBefore(container: HostContainer, child: HostNode, beforeChild: HostNode) {
    if (container.root === beforeChild) {
      container.root = child;
    } else {
      container.root = child;
    }
  },
  prepareUpdate(instance: HostElement, _type: string, oldProps: any, newProps: any) {
    if (oldProps === newProps) return null;
    return newProps;
  },
  commitUpdate(instance: HostElement, _type: string, _oldProps: any, newProps: any) {
    if (!newProps || typeof newProps !== "object") return;
    const next = createElement(instance.tag, newProps);
    instance.props = next.props;
    instance.rawProps = next.rawProps;
  },
  commitTextUpdate(textInstance: HostText, _oldText: string, newText: string) {
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
  bindToConsole(type: "error" | "warn" | "info" | "log", args: any[]) {
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
  scheduleTimeout(fn: (...args: any[]) => void, delay?: number) {
    return setTimeout(fn, delay ?? 0);
  },
  scheduleMicrotask(fn: (...args: any[]) => void) {
    queueMicrotask(fn);
  },
  cancelTimeout(id: any) {
    clearTimeout(id);
  },
  noTimeout: -1,
};

const reconciler = Reconciler(hostConfig);

export class SmithersRenderer {
  private container: HostContainer;
  private root: any;

  constructor() {
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

  async render(element: React.ReactElement, opts?: ExtractOptions) {
    (reconciler as any).updateContainerSync(element, this.root, null, () => {});
    (reconciler as any).flushSyncWork();
    return extractFromHost(this.container.root, opts);
  }

  getRoot(): HostNode | null {
    return this.container.root;
  }
}
