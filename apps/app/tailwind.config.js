/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from "node:url"

/*
 * Content globs resolve against the CONFIG, never the shell's cwd: a bare
 * "./src/mainview" only scanned the app sources when the build ran from
 * apps/app, so a root-invoked `vite build` produced a bundle with no Tailwind
 * utilities at all. src/mainview/styles/TailwindContent.test.ts holds this.
 */
const here = fileURLToPath(new URL(".", import.meta.url))

export default {
  content: [`${here}src/mainview/**/*.{html,js,ts,jsx,tsx}`],
  theme: {
    extend: {}
  },
  plugins: []
}
