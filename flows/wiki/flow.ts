import { Flow } from "@smthrs/core"
import { Input, Receipt } from "./schema.ts"
export default Flow.make({
  description: "Capture declared public source dependencies, independently review each engineering wiki page against its code, and write a provenance-bearing snapshot without modifying human intent.",
  input: Input, output: Receipt, capabilities: ["fs:read:**", "fs:write:**"], flows: ["smithers/Wiki"],
  effects: { reads: ["factory/wiki/**", "packages/**", "apps/app/**"], writes: [".flows/wiki/**"], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
