export async function copyToClipboard(text: string) {
  if (typeof navigator?.clipboard?.writeText !== "function") {
    throw new Error("Clipboard API is unavailable in this browser.")
  }

  await navigator.clipboard.writeText(text)
}
