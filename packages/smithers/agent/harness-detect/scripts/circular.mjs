import madge from "madge"

const result = await madge("src", {
  fileExtensions: ["ts"],
  tsConfig: "./tsconfig.json",
  detectiveOptions: {
    ts: {
      skipTypeImports: true
    }
  }
})
const circular = result.circular()

if (circular.length > 0) {
  console.error("Circular dependencies found")
  console.error(circular)
  process.exitCode = 1
}
