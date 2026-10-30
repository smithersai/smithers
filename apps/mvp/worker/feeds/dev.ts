// The development feed key (docs/features/feeds.md#development): `alchemy dev` (worker/DevChatApi.ts) accepts it for
// every repository while `FEED_KEYS` is unset, so a local collector and the end-to-end tests push feeds without a key of
// their own. It is not a secret: it opens only a laptop's dev server. Production bundles worker/ChatApi.ts, which never
// imports this file, and worker/ChatApi.startup.test.ts proves the production bundle never holds it.

/** The feed key `alchemy dev` accepts for every repository while `FEED_KEYS` is unset. */
export const DEV_FEED_KEY = "smithers-development-feed-key"
