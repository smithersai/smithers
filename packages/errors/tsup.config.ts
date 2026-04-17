import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.js" },
  dts: { only: true, resolve: false },
  outDir: "src",
  clean: false,
  format: ["esm"],
  silent: false,
});
