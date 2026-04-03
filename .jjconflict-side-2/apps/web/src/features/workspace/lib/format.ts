export function formatTimestamp(value?: string | null) {
  if (!value) {
    return "-"
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return value
  }

  return date.toLocaleString()
}

export function formatRelativeMinutes(minutes: number) {
  if (minutes <= 0) {
    return "just now"
  }

  if (minutes === 1) {
    return "1 minute"
  }

  if (minutes < 60) {
    return `${minutes} minutes`
  }

  const hours = Math.floor(minutes / 60)
  if (hours === 1) {
    return "1 hour"
  }

  return `${hours} hours`
}
