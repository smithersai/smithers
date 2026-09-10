import { Flow } from "@smthrs/core"
import { VibeInput, VibeLanded } from "../vibe-schema.ts"

export default Flow.make({
  description: "Retain the original source, clean and revalidate the validated native history, retain the cleaned source, and append one commit to main through the existing landing policy.",
  input: VibeInput,
  output: VibeLanded,
  capabilities: ["*"],
  flows: ["coding/RunVibe"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
