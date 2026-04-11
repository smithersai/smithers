import type { ExtractGraph } from "@smithers/graph/types";

const CORE_SPECIFIER = "@smithers/core";
const LOCAL_CORE_SPECIFIER = "../../core/src/index.ts";

type CoreModule = {
  extractGraph?: ExtractGraph;
};

async function importCoreModule(specifier: string): Promise<CoreModule | null> {
  try {
    return (await import(specifier)) as CoreModule;
  } catch {
    return null;
  }
}

export async function resolveExtractGraph(): Promise<ExtractGraph> {
  const modules = [
    await importCoreModule(CORE_SPECIFIER),
    await importCoreModule(LOCAL_CORE_SPECIFIER),
  ];
  for (const mod of modules) {
    const fn = mod?.extractGraph;
    if (typeof fn === "function") {
      return fn;
    }
  }
  throw new Error(
    "Unable to load extractGraph from @smithers/core. " +
      "Install @smithers/core and ensure it exports extractGraph.",
  );
}
