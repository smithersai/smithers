/**
 * Message-union desugaring before source extraction.
 *
 * @since 0.1.0
 */

// Foldkit's `defineMessageUnion({ Tag: { field: Schema.X } })`, read as the `_tag` union it defines.
//
// Foldkit types the union through Effect Schema, which LemmaScript does not type, so an `X.match(message, { … })`
// table over it had no union to read (`taggedMatchStatement` needs a literal `_tag` on every member). Before
// extraction, each such declaration is rewritten in memory to a plain union type plus a typed `match`:
//
//   const Message = defineMessageUnion({ Reset: {}, Set: { n: Schema.Number } })
//   type Message = typeof Message.Type
// becomes
//   type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number };
//   declare const Message: { match<R>(message: Message, handlers: { Reset: (message: {}) => R; Set: … }): R };
//
// Each rewrite keeps the declaration's line count, so reports keep the source's line numbers. A payload field
// LemmaScript cannot type is refused by name rather than read as `any`.
import { Node, type Expression, type SourceFile } from "ts-morph";

const SCALARS: Record<string, string> = { String: "string", Number: "number", Boolean: "boolean" };

/** The TypeScript type of one Schema payload field, or an error naming what is not read. */
function schemaType(expr: Expression, where: string): string {
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText() === "Schema") {
    const scalar = SCALARS[expr.getName()];
    if (scalar) return scalar;
  }
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression().getText();
    const args = expr.getArguments() as Expression[];
    const literal = (node: Node): string => {
      if (Node.isStringLiteral(node) || Node.isNumericLiteral(node) || Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return node.getText();
      throw new Error(`${where}: a Schema literal must be a string, number or boolean literal, not ${node.getText()}`);
    };
    if (callee === "Schema.Literal" && args.length > 0) return args.map(literal).join(" | ");
    if (callee === "Schema.Literals" && args.length === 1 && Node.isArrayLiteralExpression(args[0]) && args[0].getElements().length > 0) {
      return args[0].getElements().map(literal).join(" | ");
    }
    if (callee === "Schema.Array" && args.length === 1) return `ReadonlyArray<${schemaType(args[0]!, where)}>`;
  }
  throw new Error(`${where}: ${expr.getText()} is not read (read: Schema.String, Schema.Number, Schema.Boolean, Schema.Literal, Schema.Literals, Schema.Array, Schema.optionalKey, a schema named by an identifier)`);
}

/** The text with as many line breaks as `original`, so later lines keep their numbers. */
function sameLines(original: string, replacement: string): string {
  const lines = (s: string) => s.split("\n").length - 1;
  const missing = lines(original) - lines(replacement);
  if (missing < 0) throw new Error("defineMessageUnion: a rewrite may not add lines");
  return replacement + "\n".repeat(missing);
}

/** Rewrites every `const X = defineMessageUnion({ … })` in `file` in memory; returns the union names it rewrote.
 *
 * @since 0.1.0
 * @category utilities
 */
export function desugarMessageUnions(file: SourceFile): string[] {
  if (!file.getFullText().includes("defineMessageUnion(")) return [];
  const edits: { start: number; end: number; text: string }[] = [];
  const names: string[] = [];
  const aliased = new Set<string>();
  for (const alias of file.getTypeAliases()) {
    const typeText = alias.getTypeNode()?.getText().replace(/\s+/g, " ");
    if (typeText === `typeof ${alias.getName()}.Type`) aliased.add(alias.getName());
  }
  for (const statement of file.getVariableStatements()) {
    const declarations = statement.getDeclarations();
    const call = declarations.length === 1 ? declarations[0]!.getInitializer() : undefined;
    if (!call || !Node.isCallExpression(call) || call.getExpression().getText() !== "defineMessageUnion") continue;
    const name = declarations[0]!.getName();
    const at = `${file.getBaseName()}:${statement.getStartLineNumber()}`;
    const [table, ...rest] = call.getArguments();
    if (!table || rest.length > 0 || !Node.isObjectLiteralExpression(table)) throw new Error(`${at}: defineMessageUnion takes one object literal of tags`);
    const members: string[] = [];
    const handlers: string[] = [];
    for (const entry of table.getProperties()) {
      if (!Node.isPropertyAssignment(entry) || !Node.isIdentifier(entry.getNameNode())) throw new Error(`${at}: each tag of ${name} is written \`Tag: { … }\``);
      const tag = entry.getName();
      const payload = entry.getInitializer();
      if (!payload || !Node.isObjectLiteralExpression(payload)) throw new Error(`${at}: ${name}.${tag} takes an object literal of fields`);
      const fields = payload.getProperties().map(field => {
        if (!Node.isPropertyAssignment(field) || !Node.isIdentifier(field.getNameNode())) throw new Error(`${at}: each field of ${name}.${tag} is written \`field: Schema.X\``);
        const where = `${at}: ${name}.${tag}.${field.getName()}`;
        const schema = field.getInitializerOrThrow();
        if (Node.isCallExpression(schema) && schema.getExpression().getText() === "Schema.optionalKey" && schema.getArguments().length === 1) {
          return `readonly ${field.getName()}?: ${schemaType(schema.getArguments()[0] as Expression, where)}`;
        }
        return `readonly ${field.getName()}: ${schemaType(schema, where)}`;
      });
      members.push(`{ ${[`readonly _tag: "${tag}"`, ...fields].join("; ")} }`);
      handlers.push(`${tag}: (message: { ${fields.join("; ")} }) => R`);
    }
    if (members.length === 0) throw new Error(`${at}: ${name} has no tags`);
    const exported = statement.isExported() ? "export " : "";
    const typeExported = exported || (aliased.has(name) && file.getTypeAliasOrThrow(name).isExported()) ? "export " : "";
    const text = `${typeExported}type ${name} = ${members.join(" | ")}; ${exported}declare const ${name}: { match<R>(message: ${name}, handlers: { ${handlers.join("; ")} }): R };`;
    edits.push({ start: statement.getStart(), end: statement.getEnd(), text: sameLines(statement.getText(), text) });
    names.push(name);
  }
  for (const name of names) {
    if (!aliased.has(name)) continue;
    const alias = file.getTypeAliasOrThrow(name);
    edits.push({ start: alias.getStart(), end: alias.getEnd(), text: sameLines(alias.getText(), "") });
  }
  if (edits.length === 0) return [];
  let text = file.getFullText();
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  for (const name of names) text = text.replace(new RegExp(`typeof\\s+${name}\\.Type\\b`, "g"), name);
  file.replaceWithText(text);
  return names;
}
