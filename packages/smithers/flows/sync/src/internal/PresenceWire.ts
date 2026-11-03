/**
 * The presence wire's byte limits and roster encoding, shared by the
 * protocol, the room and the page's socket.
 *
 * @since 1.0.0-rc.17
 */

import type { Participant } from "../PresenceProtocol.vibe"

const utf8 = new TextEncoder()

/**
 * Whether `text` fits in `max` bytes of UTF-8. A string is never shorter in
 * UTF-8 than in UTF-16 code units, so a long string is refused before it is
 * encoded.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export const fits = (text: string, max: number): boolean => text.length <= max && utf8.encode(text).byteLength <= max

/**
 * A participant with only the protocol's fields, in the protocol's order.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export const participantOf = (participant: Participant): Participant => ({
  id: participant.id,
  principal: participant.principal,
  name: participant.name,
  access: participant.access,
  state: participant.state
})

/**
 * The roster frame for `self`, given the participants already encoded as one
 * JSON array, so a room encodes the roster once for all its sockets.
 *
 * @category encoding
 * @since 1.0.0-rc.17
 */
export const rosterFrame = (self: string, participants: string): string =>
  `{"type":"roster","self":${JSON.stringify(self)},"participants":${participants}}`
