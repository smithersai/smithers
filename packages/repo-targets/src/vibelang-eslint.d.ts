// vibelang/eslint ships no declarations (recorded in the VibeLang platform inbox), so its one export used here is typed by hand.
declare module "vibelang/eslint" {
  export function parseESTree(code: string, filePath: string): any
}
