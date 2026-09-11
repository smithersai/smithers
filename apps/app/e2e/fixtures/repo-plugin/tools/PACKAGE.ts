import { Smithers as S } from "@smthrs/targets"

const polish = S.Shell.Test({
  bun: "console.log('plugin-polish')",
  summary: "Prints plugin-polish from the tools workspace.",
})

export const Package = S.Package({
  targets: { polish },
})
