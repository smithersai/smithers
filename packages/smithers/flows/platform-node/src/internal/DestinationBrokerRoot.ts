/** Reserved host namespace and directory identity for destination brokers.
 * @since 1.0.0
 */

import { Data, Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

/** Canonical Linux directory masked after every sandbox grant.
 * @category constants
 * @since 1.0.0
 */
export const destinationBrokerRoot = "/tmp/.smthrs-egress"

/** A destination broker could not establish its confined transport.
 * @category errors
 * @since 1.0.0
 */
export class BrokerError extends Data.TaggedError("DestinationBrokerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Allocates only beneath a canonical, private directory owned by this host identity.
 * The caller supplies the operating-system identity; an unknown identity refuses.
 * @category constructors
 * @since 1.0.0
 */
export const createBrokerDirectory = (root: string, owner: number | undefined) =>
  Effect.tryPromise({
    try: async () => {
      await Fs.mkdir(root, { recursive: true, mode: 0o700 })
      const stat = await Fs.lstat(root)
      if (
        !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== owner ||
        await Fs.realpath(root) !== root
      ) throw new Error("destination broker root is not private and canonical")
      return Fs.mkdtemp(Path.join(root, "run-"))
    },
    catch: (cause) => new BrokerError({ message: "destination broker directory could not be created", cause })
  })
