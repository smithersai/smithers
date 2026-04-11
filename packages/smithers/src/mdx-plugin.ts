import { plugin, type BunPlugin } from "bun";
import mdx from "@mdx-js/esbuild";

export function mdxPlugin() {
  plugin(mdx() as unknown as BunPlugin);
}
