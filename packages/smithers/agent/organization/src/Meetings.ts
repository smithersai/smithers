/**
 * Weekly one-on-one planning and availability over zoned wall-clock time.
 *
 * A weekly plan is a contiguous block of equal slots on one ISO weekday, one
 * slot per principal in the given order, each its own weekly recurring event
 * keyed `<seriesId>/<principal>`. Times are wall-clock times in an IANA time
 * zone resolved with Effect `DateTime`, so a 09:00 Friday meeting stays at
 * 09:00 local and its UTC instant moves when daylight saving starts or ends.
 *
 * Daylight-saving edges are decided, never guessed: a wall-clock time that
 * does not exist (the spring-forward gap) refuses the plan when any slot
 * boundary in the next 400 days lands in it, and later expansion refuses too;
 * a time that happens twice (the fall-back overlap) resolves to the earlier
 * instant. A slot lasts exactly its length in real minutes.
 *
 * {@link occurrenceKey} identifies one meeting as `<eventKey>@<local date>`,
 * which depends only on the series, the principal, and the local date, so
 * recomputing a plan over any range yields the same keys for the same
 * meetings and a calendar writer can deduplicate on them.
 * {@link findSlot} finds the first free interval for an additional booking.
 *
 * @since 1.0.0
 */
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Issues from "./internal/issues.ts"
import * as Profile from "./Profile.ts"

const dayMs = 86_400_000
const weekMs = 7 * dayMs

/**
 * An ISO weekday: 1 is Monday and 7 is Sunday.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Weekday = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }))

/**
 * A wall-clock time `HH:MM`, 24-hour.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LocalTime = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { expected: "a 24-hour HH:MM time" })
)

interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

const parseDate = (text: string): CalendarDate | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
    ? { year, month, day }
    : undefined
}

/**
 * A calendar date `YYYY-MM-DD`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LocalDate = Schema.String.check(
  Schema.makeFilter<string>((text) => (parseDate(text) === undefined ? "must be a real YYYY-MM-DD date" : undefined))
)

/**
 * A meeting series id: letters, digits, `.`, `_`, and `-`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SeriesId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, { expected: "a series id without slashes" })
)

/**
 * A request for a weekly block of one-on-ones.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WeeklyRequest = Schema.Struct({
  seriesId: SeriesId,
  timezone: Schema.NonEmptyString,
  weekday: Weekday,
  start: LocalTime,
  slotMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  order: Schema.Array(Profile.PrincipalId),
  firstDate: LocalDate
})

/**
 * A request for a weekly block of one-on-ones.
 *
 * @category models
 * @since 1.0.0
 */
export type WeeklyRequest = typeof WeeklyRequest.Type

/**
 * One principal's recurring slot.
 *
 * @category models
 * @since 1.0.0
 */
export interface Slot {
  readonly principal: Profile.PrincipalId
  readonly startLocal: string
  readonly endLocal: string
  readonly eventKey: string
  readonly rrule: string
  readonly dtstartLocal: string
  readonly timezone: string
}

/**
 * A validated weekly plan.
 *
 * @category models
 * @since 1.0.0
 */
export interface WeeklyPlan {
  readonly seriesId: string
  readonly timezone: string
  readonly weekday: number
  readonly firstDate: string
  readonly slotMinutes: number
  readonly blockStart: string
  readonly blockEnd: string
  readonly slots: ReadonlyArray<Slot>
}

/**
 * Stable meeting planning failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MeetingErrorCode = Schema.Literals([
  "invalid-request",
  "unknown-timezone",
  "wrong-weekday",
  "duplicate-principal",
  "too-long",
  "crosses-midnight",
  "nonexistent-local-time",
  "invalid-range"
])

/**
 * A meeting planning failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type MeetingErrorCode = typeof MeetingErrorCode.Type

/**
 * A refused plan, expansion, or search.
 *
 * @category errors
 * @since 1.0.0
 */
export class MeetingError extends Schema.TaggedError<MeetingError>()("@smthrs/organization/Meetings/MeetingError", {
  code: MeetingErrorCode,
  message: Schema.String
}) {}

const fail = (code: MeetingErrorCode, message: string) => Result.fail(new MeetingError({ code, message }))

const byday = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

const utcMidnight = (date: CalendarDate): number => Date.UTC(date.year, date.month - 1, date.day)

const addDays = (date: CalendarDate, days: number): CalendarDate => {
  const moved = new Date(utcMidnight(date) + days * dayMs)
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() }
}

const formatDate = (date: CalendarDate): string =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`

const isoWeekday = (date: CalendarDate): number => {
  const day = new Date(utcMidnight(date)).getUTCDay()
  return day === 0 ? 7 : day
}

const zoneOf = (timezone: string): Result.Result<DateTime.TimeZone.Named, MeetingError> =>
  Option.match(DateTime.zoneMakeNamed(timezone), {
    onNone: () => fail("unknown-timezone", `time zone ${timezone} is not an IANA zone this runtime knows`),
    onSome: Result.succeed
  })

const instant = (
  zone: DateTime.TimeZone,
  date: CalendarDate,
  minutes: number,
  disambiguation: "earlier" | "later"
): DateTime.Zoned =>
  DateTime.makeZonedUnsafe(
    { ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    { timeZone: zone, adjustForTimeZone: true, disambiguation }
  )

/**
 * Resolves a wall-clock time on a date to its instant: the instant when it
 * exists once, the earlier instant when it happens twice, and `undefined`
 * when a daylight-saving gap skips it.
 */
const resolve = (zone: DateTime.TimeZone, date: CalendarDate, minutes: number): number | undefined => {
  const earlier = instant(zone, date, minutes, "earlier")
  const epochMs = DateTime.toEpochMillis(earlier)
  if (epochMs === DateTime.toEpochMillis(instant(zone, date, minutes, "later"))) return epochMs
  const wall = DateTime.toParts(earlier)
  return wall.hour * 60 + wall.minute === minutes ? epochMs : undefined
}

const localDateOf = (zone: DateTime.TimeZone, epochMs: number): CalendarDate => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(epochMs, { timeZone: zone }))
  return { year: parts.year, month: parts.month, day: parts.day }
}

/**
 * How far ahead {@link planWeekly} proves every slot boundary exists.
 *
 * @category constants
 * @since 1.0.0
 */
export const gapHorizonDays = 400

const decodeWeekly = Schema.decodeUnknownResult(WeeklyRequest, { onExcessProperty: "error" })

/**
 * Plans a contiguous weekly block: slot `i` runs from `start + i × slot` for
 * `slotMinutes`, for `order[i]`.
 *
 * Refused: a malformed request, an unknown time zone, a first date that is
 * not the weekday, an empty or repeated order, a block longer than a day or
 * ending at or after midnight, and any slot boundary within
 * {@link gapHorizonDays} days that falls in a daylight-saving gap.
 *
 * @category planning
 * @since 1.0.0
 */
export const planWeekly = (request: WeeklyRequest): Result.Result<WeeklyPlan, MeetingError> =>
  Result.gen(function*() {
    const decoded = decodeWeekly(request)
    if (Result.isFailure(decoded)) {
      return yield* fail("invalid-request", Issues.summary(Issues.problems(decoded.failure)))
    }
    const zone = yield* zoneOf(request.timezone)
    const first = parseDate(request.firstDate)!
    if (isoWeekday(first) !== request.weekday) {
      return yield* fail("wrong-weekday", `${request.firstDate} is not ISO weekday ${request.weekday}`)
    }
    if (request.order.length === 0) return yield* fail("invalid-request", "a weekly plan has at least one principal")
    const seen = new Set<string>()
    for (const principal of request.order) {
      if (seen.has(principal)) return yield* fail("duplicate-principal", `${principal} appears twice`)
      seen.add(principal)
    }
    const start = minutesOf(request.start)
    const length = request.order.length * request.slotMinutes
    if (length > 1440) return yield* fail("too-long", `the block lasts ${length} minutes, more than a day`)
    const end = start + length
    if (end >= 1440) return yield* fail("crosses-midnight", `the block runs past midnight`)
    for (let week = 0; week * 7 <= gapHorizonDays; week++) {
      const date = addDays(first, week * 7)
      for (let boundary = start; boundary <= end; boundary += request.slotMinutes) {
        if (resolve(zone, date, boundary) === undefined) {
          return yield* fail(
            "nonexistent-local-time",
            `${formatDate(date)} ${clock(boundary)} does not exist in ${zone.id}`
          )
        }
      }
    }
    const slots = request.order.map((principal, index): Slot => ({
      principal,
      startLocal: clock(start + index * request.slotMinutes),
      endLocal: clock(start + (index + 1) * request.slotMinutes),
      eventKey: `${request.seriesId}/${principal}`,
      rrule: `FREQ=WEEKLY;BYDAY=${byday[request.weekday - 1]}`,
      dtstartLocal: `${request.firstDate}T${clock(start + index * request.slotMinutes)}:00`,
      timezone: zone.id
    }))
    return {
      seriesId: request.seriesId,
      timezone: zone.id,
      weekday: request.weekday,
      firstDate: request.firstDate,
      slotMinutes: request.slotMinutes,
      blockStart: clock(start),
      blockEnd: clock(end),
      slots
    }
  })

/**
 * The stable identity of one meeting: `<eventKey>@<local date>`.
 *
 * @category keys
 * @since 1.0.0
 */
export const occurrenceKey = (eventKey: string, localDate: string): string => `${eventKey}@${localDate}`

/**
 * One concrete meeting.
 *
 * @category models
 * @since 1.0.0
 */
export interface Occurrence {
  readonly principal: Profile.PrincipalId
  readonly eventKey: string
  readonly occurrenceKey: string
  readonly localDate: string
  readonly startLocal: string
  readonly startMs: number
  readonly endMs: number
}

/**
 * The most weeks one {@link occurrences} call expands.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxExpansionWeeks = 1_000

/**
 * Every meeting of `plan` starting in `[fromMs, toMs)`, ordered by start.
 *
 * @category planning
 * @since 1.0.0
 */
export const occurrences = (
  plan: WeeklyPlan,
  fromMs: number,
  toMs: number
): Result.Result<ReadonlyArray<Occurrence>, MeetingError> =>
  Result.gen(function*() {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return yield* fail("invalid-range", "the range is [fromMs, toMs) with fromMs before toMs")
    }
    if (toMs - fromMs > maxExpansionWeeks * weekMs) {
      return yield* fail("invalid-range", `a range covers at most ${maxExpansionWeeks} weeks`)
    }
    const zone = yield* zoneOf(plan.timezone)
    const first = parseDate(plan.firstDate)!
    // Local dates sit within a day of UTC midnight, so starting one week early
    // and stopping a day past the range cannot miss a meeting.
    const skip = Math.max(0, Math.floor((fromMs - utcMidnight(first)) / weekMs) - 1)
    const found: Array<Occurrence> = []
    for (let week = skip;; week++) {
      const date = addDays(first, week * 7)
      if (utcMidnight(date) - dayMs > toMs) break
      const localDate = formatDate(date)
      for (const slot of plan.slots) {
        const startMs = resolve(zone, date, minutesOf(slot.startLocal))
        if (startMs === undefined) {
          return yield* fail("nonexistent-local-time", `${localDate} ${slot.startLocal} does not exist in ${zone.id}`)
        }
        if (startMs < fromMs || startMs >= toMs) continue
        found.push({
          principal: slot.principal,
          eventKey: slot.eventKey,
          occurrenceKey: occurrenceKey(slot.eventKey, localDate),
          localDate,
          startLocal: slot.startLocal,
          startMs,
          endMs: startMs + plan.slotMinutes * 60_000
        })
      }
    }
    return found
  })

/**
 * A half-open interval `[startMs, endMs)` in Unix milliseconds.
 *
 * @category models
 * @since 1.0.0
 */
export interface Interval {
  readonly startMs: number
  readonly endMs: number
}

/**
 * Every overlapping pair of a proposed interval and a busy interval.
 * Touching intervals do not overlap.
 *
 * @category availability
 * @since 1.0.0
 */
export const conflicts = <I extends Interval, B extends Interval>(
  intervals: ReadonlyArray<I>,
  busy: ReadonlyArray<B>
): ReadonlyArray<{ readonly interval: I; readonly busy: B }> =>
  intervals.flatMap((interval) =>
    busy.filter((block) => interval.startMs < block.endMs && block.startMs < interval.endMs)
      .map((block) => ({ interval, busy: block }))
  )

/**
 * A request for the first free interval.
 *
 * @category models
 * @since 1.0.0
 */
export interface FindSlotRequest {
  readonly busy: ReadonlyArray<Interval>
  readonly durationMinutes: number
  readonly timezone: string
  readonly window: {
    readonly weekdays: ReadonlyArray<number>
    readonly startLocal: string
    readonly endLocal: string
  }
  readonly afterMs: number
  readonly horizonDays: number
  readonly granularityMinutes: number
}

/**
 * A free interval found by {@link findSlot}.
 *
 * @category models
 * @since 1.0.0
 */
export interface FoundSlot extends Interval {
  readonly localDate: string
  readonly startLocal: string
}

/**
 * The longest search horizon, in days.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxHorizonDays = 366

/**
 * Finds the earliest interval of `durationMinutes` that starts at or after
 * `afterMs` on a window weekday, starts on the window's granularity grid in
 * local time, ends by the window's local end, and overlaps nothing busy.
 * Candidate starts in a daylight-saving gap are skipped.
 *
 * @category availability
 * @since 1.0.0
 */
export const findSlot = (request: FindSlotRequest): Result.Result<Option.Option<FoundSlot>, MeetingError> =>
  Result.gen(function*() {
    const positive = (value: number, maximum: number) => Number.isSafeInteger(value) && value > 0 && value <= maximum
    if (
      !positive(request.durationMinutes, 1440) || !positive(request.granularityMinutes, 1440) ||
      !positive(request.horizonDays, maxHorizonDays) || !Number.isFinite(request.afterMs)
    ) {
      return yield* fail("invalid-request", "duration, granularity, and horizon are positive integers within bounds")
    }
    const { endLocal, startLocal, weekdays } = request.window
    if (!Schema.is(LocalTime)(startLocal) || !Schema.is(LocalTime)(endLocal) || startLocal >= endLocal) {
      return yield* fail("invalid-request", "the window runs from startLocal to a later endLocal, both HH:MM")
    }
    if (weekdays.length === 0 || !weekdays.every((day) => Schema.is(Weekday)(day))) {
      return yield* fail("invalid-request", "the window names ISO weekdays 1 to 7")
    }
    const zone = yield* zoneOf(request.timezone)
    const open = minutesOf(startLocal)
    const close = minutesOf(endLocal)
    const duration = request.durationMinutes * 60_000
    const first = localDateOf(zone, request.afterMs)
    for (let offset = 0; offset <= request.horizonDays; offset++) {
      const date = addDays(first, offset)
      if (!weekdays.includes(isoWeekday(date))) continue
      // A closing time inside a gap resolves to its earlier reading, one gap
      // length before the wall time; that is conservative, so a slot never
      // runs past the window.
      const closeMs = DateTime.toEpochMillis(instant(zone, date, close, "earlier"))
      for (let minute = open; minute + request.durationMinutes <= close; minute += request.granularityMinutes) {
        const startMs = resolve(zone, date, minute)
        if (startMs === undefined || startMs < request.afterMs || startMs + duration > closeMs) continue
        const candidate = { startMs, endMs: startMs + duration }
        if (conflicts([candidate], request.busy).length > 0) continue
        return Option.some({ ...candidate, localDate: formatDate(date), startLocal: clock(minute) })
      }
    }
    return Option.none()
  })
