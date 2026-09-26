import { glob } from "astro/loaders"
import { z } from "astro/zod"
import { defineCollection } from "astro:content"
export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.md", base: "../tui/docs" }),
    schema: z.object({
      title: z.string(),
      description: z.string(),
      order: z.number(),
      section: z.enum(["Start", "Use the TUI", "Automate", "Reference"]).default("Start")
    })
  })
}
