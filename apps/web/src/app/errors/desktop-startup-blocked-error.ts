import {
  parseDesktopStartupError,
  type DesktopStartupErrorPayload,
} from "@burns/shared"

export class DesktopStartupBlockedError extends Error {
  readonly title: string
  readonly details: string | null

  constructor(payload: DesktopStartupErrorPayload) {
    super(payload.message)
    this.name = "DesktopStartupBlockedError"
    this.title = payload.title
    this.details = payload.details ?? null
  }
}

export function readDesktopStartupBlockedError(payload: unknown): DesktopStartupBlockedError | null {
  const parsedPayload = parseDesktopStartupError(payload)
  if (!parsedPayload) {
    return null
  }

  return new DesktopStartupBlockedError(parsedPayload)
}

export function readDesktopStartupBlockedErrorFromWindow(
  windowLike: Pick<Window, "__BURNS_STARTUP_ERROR__">
): DesktopStartupBlockedError | null {
  const payload = readDesktopStartupBlockedError(windowLike.__BURNS_STARTUP_ERROR__)
  if (!payload) {
    return null
  }

  return payload
}
