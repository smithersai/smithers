/**
 * A bounded diagnostic tail. Keep enough input to recognize credentials split
 * across writes, and redact overlapping matches before discarding raw input.
 */
export const redactingTail = (secrets: ReadonlyArray<string>, limit: number) => {
  const values = secrets.filter((value) => value.length > 0)
  const lookbehind = values.reduce((longest, value) => Math.max(longest, value.length - 1), 0)
  let pending = ""
  let tail = ""
  let redactedThrough = 0
  let continuing = false
  const append = (chunk: string, final: boolean) => {
    pending += chunk
    const safe = final ? pending.length : Math.max(0, pending.length - lookbehind)
    if (safe === 0) return
    const ranges: Array<[number, number]> = redactedThrough > 0 ? [[0, redactedThrough]] : []
    for (const value of values) {
      for (let start = pending.indexOf(value); start !== -1; start = pending.indexOf(value, start + 1)) {
        ranges.push([start, start + value.length])
      }
    }
    ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous && range[0] < previous[1]) previous[1] = Math.max(previous[1], range[1])
      else merged.push(range)
    }
    let cursor = 0
    const output: Array<string> = []
    let nextContinuing = false
    redactedThrough = 0
    for (const [start, end] of merged) {
      if (start >= safe) break
      output.push(pending.slice(cursor, start))
      if (start > 0 || !continuing) output.push("<redacted>")
      cursor = Math.min(end, safe)
      if (end > safe) {
        redactedThrough = end - safe
        nextContinuing = true
        break
      }
    }
    output.push(pending.slice(cursor, safe))
    continuing = nextContinuing
    pending = pending.slice(safe)
    tail = (tail + output.join("")).slice(-limit)
  }
  return {
    write: (chunk: string) => append(chunk, false),
    end: (chunk = "") => {
      append(chunk, true)
      return tail
    }
  }
}
