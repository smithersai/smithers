import { Schema } from "effect";

export default (config: { suffix?: string } = {}) => ({
  name: "toon-test-plugin",
  nodes: {
    shout: (node: any, env: any) => {
      const id = String(node.id ?? "shout");
      const text = String(node.text ?? "");
      const suffix = typeof config.suffix === "string" ? config.suffix : "";
      return env.builder.step(id, {
        output: Schema.Struct({ value: Schema.String }),
        run: () => ({ value: `${text}${suffix}`.toUpperCase() }),
      });
    },
  },
});
