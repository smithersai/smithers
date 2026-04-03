import { z } from "zod"

export const DEFAULT_BURNS_API_URL = "http://localhost:7332"

export const runtimeModeSchema = z.enum(["dev", "desktop", "cli"])
export const runtimeEnvironmentSchema = z.enum(["desktop", "local", "remote"])
export const runtimeContextSourceSchema = z.enum(["process-mode", "request-host"])
export const runtimeOsSchema = z.enum(["darwin", "linux", "windows", "unknown"])

export const runtimeCapabilitiesSchema = z.object({
  openNativeFolderPicker: z.boolean(),
  openTerminal: z.boolean(),
  openVscode: z.boolean(),
})

export const burnsRuntimeContextSchema = z.object({
  runtimeMode: runtimeModeSchema,
  environment: runtimeEnvironmentSchema,
  source: runtimeContextSourceSchema,
  os: runtimeOsSchema,
  gitCommitShort: z.string().min(1).nullable(),
  requestHostIsLoopback: z.boolean(),
  capabilities: runtimeCapabilitiesSchema,
})

export const burnsRuntimeConfigSchema = z.object({
  burnsApiUrl: z.string().url(),
  runtimeMode: runtimeModeSchema.optional(),
})

export const burnsRuntimeApiUrlSourceSchema = z.enum([
  "runtime-config",
  "vite-env",
  "fallback",
])

export const burnsResolvedApiUrlSchema = z.object({
  apiUrl: z.string().url(),
  source: burnsRuntimeApiUrlSourceSchema,
})

export type RuntimeMode = z.infer<typeof runtimeModeSchema>
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>
export type RuntimeContext = z.infer<typeof burnsRuntimeContextSchema>
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>
export type RuntimeOs = z.infer<typeof runtimeOsSchema>
export type BurnsRuntimeConfig = z.infer<typeof burnsRuntimeConfigSchema>
export type BurnsRuntimeApiUrlSource = z.infer<typeof burnsRuntimeApiUrlSourceSchema>
export type BurnsResolvedApiUrl = z.infer<typeof burnsResolvedApiUrlSchema>
