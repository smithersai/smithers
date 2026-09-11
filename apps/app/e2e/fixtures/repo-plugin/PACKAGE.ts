import { Smithers as S } from "@smthrs/targets"

const hello = S.Shell.Test({
  bun: "console.log('plugin-hello')",
  summary: "Prints plugin-hello from the root workspace.",
})

export const Package = S.Package({
  targets: { hello },
})
