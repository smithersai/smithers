/**
 * Spec expression parser.
 * Parses //@ annotation expressions into RawExpr AST nodes.
 */

import type { RawExpr } from "./rawir.js";
import { normalizeBigIntLiteral } from "./rawir.js";

export type Expr = RawExpr;

// ── Tokenizer ────────────────────────────────────────────────

type Token =
  | { type: "num"; value: number }
  | { type: "bigint"; value: string }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "punc"; value: string }
  | { type: "result"; value: undefined };

const MULTI_OPS = ["<==>", "==>", "===", "!==", "==", "!=", ">=", "<=", "&&", "||"];

/** Numeric literals accepted in specs. BigInts are recognized first so their
 *  exact value never passes through Number; ordinary numbers additionally
 *  allow TypeScript's fractional and exponent forms. */
const BIGINT_LITERAL =
  /^(?:(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*)|(?:0[bB][01](?:_?[01])*)|(?:0[oO][0-7](?:_?[0-7])*)|(?:[0-9](?:_?[0-9])*))n/;
const NUMBER_LITERAL =
  /^(?:(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*)|(?:0[bB][01](?:_?[01])*)|(?:0[oO][0-7](?:_?[0-7])*)|(?:(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.(?:[0-9](?:_?[0-9])*))(?:[eE][+-]?(?:[0-9](?:_?[0-9])*))?)/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) { i++; continue; }

    if (input[i] === "\\" && input.slice(i + 1, i + 7) === "result") {
      tokens.push({ type: "result", value: undefined });
      i += 7;
      continue;
    }

    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let s = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\") {
          // Standard escapes, where TS source, Dafny, and Lean all agree.
          // The emitters re-escape on output, so the round trip is faithful.
          const esc = input[i + 1];
          const mapped = esc === "n" ? "\n" : esc === "r" ? "\r" : esc === "t" ? "\t"
            : esc === "0" ? "\0" : esc === "\\" || esc === '"' || esc === "'" ? esc : null;
          if (mapped === null) throw new Error(`Unsupported string escape '\\${esc}' at ${i} in: ${input}`);
          s += mapped;
          i += 2;
        } else {
          s += input[i++];
        }
      }
      if (i < input.length) i++;
      tokens.push({ type: "str", value: s });
      continue;
    }

    if (/[0-9]/.test(input[i]) || (input[i] === "." && /[0-9]/.test(input[i + 1]))) {
      const rest = input.slice(i);
      const bigintMatch = rest.match(BIGINT_LITERAL);
      const match = bigintMatch ?? rest.match(NUMBER_LITERAL);
      if (!match) throw new Error(`Invalid numeric literal at ${i} in: ${input}`);
      const text = match[0];
      i += text.length;
      // The `n` suffix is meaningful, not noise: a BigInt keeps its exact value
      // as a decimal string instead of being rounded into a double.
      if (bigintMatch) tokens.push({ type: "bigint", value: normalizeBigIntLiteral(text) });
      else tokens.push({ type: "num", value: Number(text.replace(/_/g, "")) });
      continue;
    }

    if (/[a-zA-Z_]/.test(input[i])) {
      let id = "";
      while (i < input.length && /[a-zA-Z_0-9]/.test(input[i])) id += input[i++];
      tokens.push({ type: "ident", value: id });
      continue;
    }

    let matched = false;
    for (const op of MULTI_OPS) {
      if (input.slice(i, i + op.length) === op) {
        tokens.push({ type: "op", value: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const ch = input[i];
    if ("+-*/%><!?".includes(ch)) {
      tokens.push({ type: "op", value: ch });
    } else if ("()[],:.{}".includes(ch)) {
      tokens.push({ type: "punc", value: ch });
    } else {
      throw new Error(`Unexpected '${ch}' at ${i} in: ${input}`);
    }
    i++;
  }
  return tokens;
}

// ── Parser ───────────────────────────────────────────────────

class Parser {
  pos = 0;
  constructor(private tokens: Token[]) {}

  peek() { return this.tokens[this.pos]; }
  advance() { return this.tokens[this.pos++]; }
  expect(type: string, value?: string) {
    const t = this.advance();
    if (!t || t.type !== type || (value !== undefined && t.value !== value))
      throw new Error(`Expected ${type}${value ? ` '${value}'` : ""}, got ${t ? JSON.stringify(t) : "EOF"}`);
    return t;
  }
  match(type: string, value?: string) {
    const t = this.peek();
    if (t && t.type === type && (value === undefined || t.value === value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): Expr {
    const r = this.parseIff();
    if (this.pos < this.tokens.length) throw new Error(`Unexpected: ${JSON.stringify(this.peek())}`);
    return r;
  }

  // <==> binds loosest (Dafny precedence: a ==> b <==> c is (a ==> b) <==> c),
  // right-associative like ==> — immaterial semantically, iff is associative.
  parseIff(): Expr {
    const left = this.parseImplies();
    if (this.match("op", "<==>")) return { kind: "binop", op: "<==>", left, right: this.parseIff() };
    return left;
  }

  parseImplies(): Expr {
    const left = this.parseTernary();
    if (this.match("op", "==>")) return { kind: "binop", op: "==>", left, right: this.parseImplies() };
    return left;
  }

  parseTernary(): Expr {
    const cond = this.parseOr();
    if (this.match("op", "?")) {
      const then_ = this.parseIff();
      this.expect("punc", ":");
      const else_ = this.parseIff();
      return { kind: "conditional", cond, then: then_, else: else_ };
    }
    return cond;
  }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.match("op", "||")) left = { kind: "binop", op: "||", left, right: this.parseAnd() };
    return left;
  }

  parseAnd(): Expr {
    let left = this.parseCmp();
    while (this.match("op", "&&")) left = { kind: "binop", op: "&&", left, right: this.parseCmp() };
    return left;
  }

  parseCmp(): Expr {
    const left = this.parseAdd();
    const t = this.peek();
    // 'in' as infix membership operator (set/seq/map): x in S
    if (t?.type === "ident" && t.value === "in") {
      this.advance();
      return { kind: "binop", op: "in", left, right: this.parseAdd() };
    }
    if (t?.type === "op" && ["===", "!==", "==", "!=", ">=", "<=", ">", "<"].includes(t.value)) {
      this.advance();
      // Normalize == to ===, != to !== so downstream sees one spelling
      const op = t.value === "==" ? "===" : t.value === "!=" ? "!==" : t.value;
      return { kind: "binop", op, left, right: this.parseAdd() };
    }
    return left;
  }

  parseAdd(): Expr {
    let left = this.parseMul();
    while (this.peek()?.type === "op" && ["+", "-"].includes(this.peek()!.value as string)) {
      const op = this.advance().value as string;
      left = { kind: "binop", op, left, right: this.parseMul() };
    }
    return left;
  }

  parseMul(): Expr {
    let left = this.parseUnary();
    while (this.peek()?.type === "op" && ["*", "/", "%"].includes(this.peek()!.value as string)) {
      const op = this.advance().value as string;
      left = { kind: "binop", op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary(): Expr {
    if (this.match("op", "!")) return { kind: "unop", op: "!", expr: this.parseUnary() };
    if (this.peek()?.type === "op" && this.peek()!.value === "-") {
      const prev = this.pos > 0 ? this.tokens[this.pos - 1] : undefined;
      if (!prev || prev.type === "op" || (prev.type === "punc" && prev.value !== ")")) {
        this.advance();
        return { kind: "unop", op: "-", expr: this.parseUnary() };
      }
    }
    return this.parsePostfix();
  }

  parsePostfix(): Expr {
    let expr = this.parseAtom();
    while (true) {
      if (this.match("punc", ".")) {
        expr = { kind: "field", obj: expr, field: (this.expect("ident").value as string) };
      } else if (this.match("punc", "[")) {
        const idx = this.parseIff();
        this.expect("punc", "]");
        expr = { kind: "index", obj: expr, idx };
      } else if (this.match("punc", "(")) {
        const args: Expr[] = [];
        if (!this.match("punc", ")")) {
          args.push(this.parseIff());
          while (this.match("punc", ",")) args.push(this.parseIff());
          this.expect("punc", ")");
        }
        expr = { kind: "call", fn: expr, args };
      } else break;
    }
    return expr;
  }

  parseAtom(): Expr {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "result") { this.advance(); return { kind: "result" }; }
    if (t.type === "num") { this.advance(); return { kind: "num", value: t.value }; }
    if (t.type === "bigint") { this.advance(); return { kind: "bigint", value: t.value }; }
    if (t.type === "str") { this.advance(); return { kind: "str", value: t.value }; }
    if (t.type === "ident") {
      if (t.value === "true") { this.advance(); return { kind: "bool", value: true }; }
      if (t.value === "false") { this.advance(); return { kind: "bool", value: false }; }
      // Match the body extractor (extract.ts NullLiteral): `null` and
      // `undefined` are interchangeable in LS, both map to None.
      if (t.value === "null") { this.advance(); return { kind: "var", name: "undefined" }; }
      // new Set<T>() / new Map<K,V>()
      if (t.value === "new") {
        this.advance();
        const name = this.expect("ident").value as string;
        if (name !== "Set" && name !== "Map") throw new Error(`Unsupported constructor: new ${name}`);
        // Skip <T> or <K,V> type arguments
        let tsType = name;
        if (this.match("op", "<")) {
          let depth = 1;
          let typeArgs = "";
          while (depth > 0) {
            const next = this.advance();
            if (next.value === "<") depth++;
            else if (next.value === ">") { depth--; if (depth === 0) break; }
            typeArgs += next.value;
          }
          tsType = `${name}<${typeArgs}>`;
        }
        this.expect("punc", "(");
        this.expect("punc", ")");
        return { kind: "emptyCollection", collectionType: name as "Set" | "Map", tsType };
      }
      if (t.value === "forall" || t.value === "exists") {
        const q = t.value as "forall" | "exists";
        this.advance();
        this.expect("punc", "(");
        const v = this.expect("ident").value as string;
        let varType: string = "int";
        if (this.match("punc", ":")) {
          const ty = this.expect("ident").value as string;
          varType = ty;
        }
        this.expect("punc", ",");
        const body = this.parseIff();
        this.expect("punc", ")");
        return { kind: q, var: v, varType, body };
      }
      this.advance();
      return { kind: "var", name: t.value };
    }
    if (t.type === "punc" && t.value === "(") {
      this.advance();
      const expr = this.parseIff();
      this.expect("punc", ")");
      return expr;
    }
    if (t.type === "punc" && t.value === "[") {
      this.advance();
      const elems: Expr[] = [];
      if (!this.match("punc", "]")) {
        elems.push(this.parseIff());
        while (this.match("punc", ",")) elems.push(this.parseIff());
        this.expect("punc", "]");
      }
      return { kind: "arrayLiteral", elems };
    }
    if (t.type === "punc" && t.value === "{") {
      this.advance();
      const fields: { name: string; value: Expr }[] = [];
      if (!this.match("punc", "}")) {
        const name = this.expect("ident").value as string;
        this.expect("punc", ":");
        fields.push({ name, value: this.parseIff() });
        while (this.match("punc", ",")) {
          const n = this.expect("ident").value as string;
          this.expect("punc", ":");
          fields.push({ name: n, value: this.parseIff() });
        }
        this.expect("punc", "}");
      }
      return { kind: "record", spread: null, fields };
    }
    throw new Error(`Unexpected: ${JSON.stringify(t)}`);
  }
}

export function parseExpr(input: string): Expr {
  return new Parser(tokenize(input)).parse();
}
