import { z } from "zod"

export const DESKTOP_STARTUP_ERROR_EVENT = "burns:startup-error"

export const desktopStartupErrorSchema = z.object({
  title: z.string().trim().min(1),
  message: z.string().trim().min(1),
  details: z.string().trim().min(1).nullable().optional(),
})

export type DesktopStartupErrorPayload = z.infer<typeof desktopStartupErrorSchema>

export function parseDesktopStartupError(value: unknown): DesktopStartupErrorPayload | null {
  const parsedPayload = desktopStartupErrorSchema.safeParse(value)
  return parsedPayload.success ? parsedPayload.data : null
}

export function buildDesktopStartupErrorInitScript(payload: DesktopStartupErrorPayload): string {
  const parsedPayload = desktopStartupErrorSchema.parse(payload)
  const jsonPayload = JSON.stringify(parsedPayload)
  const eventName = JSON.stringify(DESKTOP_STARTUP_ERROR_EVENT)

  return [
    `window.__BURNS_STARTUP_ERROR__ = Object.freeze(${jsonPayload});`,
    `window.dispatchEvent(new CustomEvent(${eventName}));`,
  ].join("")
}
