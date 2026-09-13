/** Private server-to-server destinations; never an arbitrary URL proxy. */
export const TUTORIAL_PROVIDER_PROXY_PATH = "/api/tutorial/provider"
export const TUTORIAL_PROXY_TOKEN_HEADER = "x-smithers-proxy-token"
export const tutorialProviderDestinations = {
  chatgpt: "https://chatgpt.com/backend-api/codex/responses",
  refresh: "https://auth.openai.com/oauth/token",
  openai: "https://api.openai.com/v1/responses",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
} as const
