// What a message shows besides its text (docs/features/chat.md#message-controls), worked out for the view so the React
// component only renders it.

/** Postgres' text form of a `timestamptz`, as Electric delivers it: `2026-10-20 19:01:02.123456+00`. */
const POSTGRES_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:([+-]\d{2})(?::?(\d{2}))?|Z)$/

/** A `timestamptz` as Postgres prints it, in epoch milliseconds; `undefined` when it isn't one. */
export const postgresTime = (text: string): number | undefined => {
  const parts = POSTGRES_TIME.exec(text)
  if (parts === null) return undefined
  const [, date, time, fraction = "", hours, minutes = "00"] = parts
  const zone = hours === undefined ? "Z" : `${hours}:${minutes}`
  const ms = Date.parse(`${date}T${time}.${fraction.padEnd(3, "0").slice(0, 3)}${zone}`)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * When a row of the conversation was asked or written, in epoch milliseconds: a question this device hasn't sent yet
 * by when it was asked here (`at`), every other row by its `createdAt` in Postgres. `undefined` shows no time.
 */
export const timeOf = (row: { readonly local: number; readonly at: number; readonly createdAt: string }) =>
  row.local === 1 ? row.at : postgresTime(row.createdAt)
