/*
 * The product app as this site's React island. apps/app owns the component;
 * the site only reaches it by relative path, the way AvailableRepos.astro
 * reaches apps/server's catalog, so the two apps stay one build with one
 * React and one Effect (astro.config.mjs dedupes both).
 */
export { default } from "../../app/src/mainview/AppIsland"
