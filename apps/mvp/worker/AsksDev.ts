// The development ask token (docs/features/agent-status.md#development): `alchemy dev` (worker/DevChatApi.ts) takes it
// as an agent's machine token holding `ask/create` on every repository, so a local agent and the end-to-end tests ask a
// person without issuing a token. It is not a secret: it opens only a laptop's dev server. Production bundles
// worker/ChatApi.ts, which never imports this file, and worker/ChatApi.startup.test.ts proves the production bundle
// never holds it.

/** The bearer `alchemy dev` takes as agent `development`, lane `local`, asking on any repository. */
export const DEV_ASK_TOKEN = "smm_smithers-development-ask-token"
