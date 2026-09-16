/** The existing host trial input accepts an actual PR URL or source/number. */
export function setupTrialPr(body: string): { source: "github" | "smithers-cloud"; number?: number } {
  const url = body.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:\b|\/)/)
  if (url && Number.isSafeInteger(Number(url[1])) && Number(url[1]) > 0) return { source: "github", number: Number(url[1]) }
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object" && "source" in parsed && (parsed.source === "github" || parsed.source === "smithers-cloud")) {
      const number = "number" in parsed ? parsed.number : undefined
      return { source: parsed.source, ...(typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? { number } : {}) }
    }
  } catch { /* An unconfigured trial may still contain the default description. */ }
  return { source: "github" }
}
