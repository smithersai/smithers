/**
 * The bounded-read file handle slice of a ZenFS promises API.
 *
 * @since 1.0.0-rc.0
 */

/**
 * The bounded-read slice shared by ZenFS and Node file handles.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface ZenFsFileHandleLike {
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ readonly bytesRead: number }>
  readonly close: () => Promise<void>
}
