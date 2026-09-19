import type { AppStore } from "../AppStore"

/*
 * SAID ONCE, AND SAID FOR THIS ACT.
 *
 * Two surfaces can say the same sentence about one act: the door that refused
 * it (`message.appended` with `spoken: true`, see {@link Message.spoken}) and
 * the surface that reports the act's outcome — a form card's error row, the
 * command failure path. A second identical line reads as a second failure that
 * did not happen, so the reporting surface yields to the door's line.
 *
 * It yields to THAT line and only to that line. What makes a line the door's
 * is the door SAYING so, not its position: comparing against the transcript's
 * tail meant any line appended in between — another actor's, a seam's answer,
 * the next turn — brought the duplicate straight back, and, worse, a SECOND
 * lost act whose sentence happened to already be the tail went silent, which
 * is the fault this rule exists to prevent.
 *
 * The window is the other half. A door's sentence from minutes ago must not
 * silence the act the person is looking at now, so the caller records the
 * transcript's latest ordinal when the act is admitted and only a line spoken
 * after that point can stand in for it. A caller with no window of its own
 * passes the ordinal as of now, which matches nothing: the failure mode of a
 * surface that forgets is one duplicate line, never silence.
 */

type Transcript = Pick<AppStore["collections"], "messages">

/** The transcript's high-water mark, recorded before an act so its own lines can be told apart. */
export const latestOrdinal = (collections: Transcript): number => {
  let latest = 0
  for (const message of collections.messages.values()) latest = Math.max(latest, message.ordinal)
  return latest
}

/** Did a door already say this sentence, in the transcript, since `since`? */
export const alreadySaid = (collections: Transcript, sentence: string, since: number): boolean => {
  for (const message of collections.messages.values()) {
    if (message.spoken === true && message.ordinal > since && message.text === sentence) return true
  }
  return false
}
