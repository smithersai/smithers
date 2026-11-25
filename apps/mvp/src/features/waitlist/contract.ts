export const WAITLIST_JOIN_ROUTE = "/api/waitlist/join"
export const WAITLIST_MAX_BODY_BYTES = 4_096
export const WAITLIST_MAX_URL_LENGTH = 256
export const WAITLIST_MAX_NOTE_LENGTH = 120

export type WaitlistJoinResponse = {
  readonly status: "submitted"
  readonly repoUrl: string
  readonly position: number
}
