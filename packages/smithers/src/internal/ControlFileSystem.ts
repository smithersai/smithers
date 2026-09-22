/** The shared descriptor-relative filesystem for native control hosts. */
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"

export const layer = (): typeof AtomicFileSystem.layer => AtomicFileSystem.layer
