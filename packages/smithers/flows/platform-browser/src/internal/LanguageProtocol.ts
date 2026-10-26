/**
 * The messages between a tab and its language-server worker
 * (`BrowserLanguageServer`). Both halves ship in one package version, so the
 * messages are plain structured-clone values without a codec.
 *
 * @since 1.0.0
 */

import type { StdError } from "@smthrs/std"
import type { Read } from "./TypeScriptWorkspace.ts"

/**
 * The requests a worker answers.
 *
 * @category models
 * @since 1.0.0
 */
export type Method =
  | "hover"
  | "definition"
  | "references"
  | "implementation"
  | "documentSymbols"
  | "workspaceSymbols"
  | "diagnostics"
  | "sync"
  | "close"

/**
 * A request's arguments: a 0-based position in an absolute path, a query, or a file's new text.
 *
 * @category models
 * @since 1.0.0
 */
export interface Params {
  readonly path?: string
  readonly line?: number
  readonly character?: number
  readonly query?: string
  readonly text?: string
}

/**
 * Tab to worker: one request, answered by `Reply` or `Refuse` with its `id`.
 *
 * @category models
 * @since 1.0.0
 */
export interface RequestMessage {
  readonly _tag: "Request"
  readonly id: number
  readonly method: Method
  readonly params: Params
}

/**
 * Worker to tab: the files a request needs, answered by `Files` with its `id`.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReadMessage {
  readonly _tag: "Read"
  readonly id: number
  readonly paths: ReadonlyArray<string>
}

/**
 * Tab to worker: the workspace's file list first, then requests and the files the worker asked for.
 *
 * @category models
 * @since 1.0.0
 */
export type ToWorker =
  | { readonly _tag: "Open"; readonly paths: ReadonlyArray<string> }
  | RequestMessage
  | { readonly _tag: "Cancel"; readonly id: number }
  | { readonly _tag: "Files"; readonly id: number; readonly files: Read }

/**
 * Worker to tab: an answer, a refusal, or a request for files.
 *
 * @category models
 * @since 1.0.0
 */
export type FromWorker =
  | {
    readonly _tag: "Reply"
    readonly id: number
    readonly result: unknown
    /** The workspace files loaded so far, and whether a limit stopped a load. */
    readonly files: number
    readonly partial: boolean
  }
  | {
    readonly _tag: "Refuse"
    readonly id: number
    readonly method: Method
    readonly code: StdError.Code
    readonly message: string
  }
  | ReadMessage
  | { readonly _tag: "CancelRead"; readonly id: number }

/**
 * What the tab's listeners hand its dispatcher.
 *
 * @category models
 * @since 1.0.0
 */
export type Event =
  | { readonly _tag: "Message"; readonly data: unknown }
  | { readonly _tag: "Failed"; readonly error: string }

/**
 * The worker's side of the channel: its global scope, or a `MessagePort`,
 * whose `start` begins delivery once the listener is in place.
 *
 * @category models
 * @since 1.0.0
 */
export interface Port {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
  start?(): void
}

/**
 * A reply as the tab's request receives it.
 *
 * @category models
 * @since 1.0.0
 */
export type Answer = Extract<FromWorker, { readonly _tag: "Reply" }>
