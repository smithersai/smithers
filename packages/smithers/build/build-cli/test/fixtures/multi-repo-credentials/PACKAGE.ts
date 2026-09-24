import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: {
    childTest: S.Repo.Target("child", "//:test")
  }
})
