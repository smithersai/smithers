import { Smithers as S } from "@smthrs/targets"

// The parent's cache credentials must never reach a child repository's
// declarations, nor any tool the child runs.
const leaked = ["MY_CACHE_TOKEN", "MY_CACHE_WRITE_TOKEN", "SMITHERS_CACHE_TOKEN", "SMITHERS_CACHE_URL"]
for (const name of leaked) {
  if (process.env[name] !== undefined) throw new Error(`credential ${name} leaked into child declaration`)
}

export const Package = S.Package({
  targets: {
    test: S.Shell.Test({
      bin: S.Runtime.bin,
      args: [
        "-e",
        `for (const name of ${JSON.stringify(leaked)}) if (process.env[name] !== undefined) ` +
        "{ console.error(`credential ${name} leaked into child tool`); process.exit(3) } " +
        "console.log('child repository clean')"
      ]
    })
  }
})
