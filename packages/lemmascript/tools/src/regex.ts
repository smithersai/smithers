// A JavaScript regular-expression subset as the Dafny `JsRe` datatype of the regex preamble below (`REGEX_CORE`):
// literal code units, `.`, classes and their escapes, groups, alternation, and the quantifiers `* + ? {m} {m,} {m,n}`
// (greedy or lazy: `test` answers the same), with `^` first and `$` last. No flags. Anything else is refused by name.

export type Re =
  | { kind: "eps" }
  | { kind: "cls"; ranges: ReadonlyArray<readonly [number, number]>; neg: boolean }
  | { kind: "cat"; a: Re; b: Re }
  | { kind: "alt"; a: Re; b: Re }
  | { kind: "star"; a: Re };

export interface Pattern { readonly re: Re; readonly bol: boolean; readonly eol: boolean }

export class RegexRefused extends Error {}

const EPS: Re = { kind: "eps" };
const cat = (a: Re, b: Re): Re => a.kind === "eps" ? b : b.kind === "eps" ? a : { kind: "cat", a, b };
const one = (c: number): Re => ({ kind: "cls", ranges: [[c, c]], neg: false });

const DIGIT: ReadonlyArray<readonly [number, number]> = [[48, 57]];
const WORD: ReadonlyArray<readonly [number, number]> = [[48, 57], [65, 90], [95, 95], [97, 122]];
// ECMAScript WhiteSpace and LineTerminator code units.
const SPACE: ReadonlyArray<readonly [number, number]> = [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202],
  [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]];
// `.` without the `s` flag: every code unit but a line terminator.
const LINE: ReadonlyArray<readonly [number, number]> = [[10, 10], [13, 13], [8232, 8233]];
const MAX_REPEAT = 64;

export function parsePattern(source: string, flags: string): Pattern {
  if (flags !== "") throw new RegexRefused(`regular expression flags "${flags}" are outside the supported subset (none)`);
  let at = 0;
  const bol = source.startsWith("^");
  if (bol) at = 1;
  const eol = source.length > at && source.endsWith("$") && !escapedAt(source, source.length - 1);
  const end = eol ? source.length - 1 : source.length;
  const fail = (what: string): never => { throw new RegexRefused(`${what} at ${at} in /${source}/ is outside the supported subset`); };

  let depth = 0;
  function alternation(): Re {
    let left = sequence();
    while (at < end && source[at] === "|") {
      // `^a|b` is `(^a)|b`: a top-level alternative beside an anchor is not anchored.
      if (depth === 0 && (bol || eol)) fail("an alternation beside an anchor");
      at++;
      left = { kind: "alt", a: left, b: sequence() };
    }
    return left;
  }
  function sequence(): Re {
    let out: Re = EPS;
    while (at < end && source[at] !== "|" && source[at] !== ")") out = cat(out, quantified(atom()));
    return out;
  }
  function quantified(r: Re): Re {
    for (;;) {
      const c = source[at];
      if (at >= end) return r;
      if (c === "*") { at++; r = { kind: "star", a: r }; }
      else if (c === "+") { at++; r = cat(r, { kind: "star", a: r }); }
      else if (c === "?") { at++; r = { kind: "alt", a: r, b: EPS }; }
      else if (c === "{" && /^\{\d+(,\d*)?\}/.test(source.slice(at, end))) {
        const [, lo, comma, hi] = /^\{(\d+)(,)?(\d*)\}/.exec(source.slice(at, end))!;
        at += /^\{\d+(,\d*)?\}/.exec(source.slice(at, end))![0].length;
        const m = Number(lo), n = comma === undefined ? m : hi === "" ? Infinity : Number(hi);
        if (n < m) fail("a quantifier {m,n} with n < m");
        if (m > MAX_REPEAT || (n !== Infinity && n > MAX_REPEAT)) fail(`a repeat count above ${MAX_REPEAT}`);
        let out: Re = EPS;
        for (let i = 0; i < m; i++) out = cat(out, r);
        if (n === Infinity) out = cat(out, { kind: "star", a: r });
        else for (let i = m; i < n; i++) out = cat(out, { kind: "alt", a: r, b: EPS });
        r = out;
      } else return r;
      if (at < end && source[at] === "?") at++; // lazy: the same language
    }
  }
  function atom(): Re {
    const c = source[at]!;
    if (c === "(") {
      at++;
      if (source.startsWith("?:", at)) at += 2;
      else if (source[at] === "?") fail("a lookaround or named group");
      depth++;
      const inner = alternation();
      depth--;
      if (source[at] !== ")") fail("an unclosed group");
      at++;
      return inner;
    }
    if (c === "[") return charClass();
    if (c === ".") { at++; return { kind: "cls", ranges: LINE, neg: true }; }
    if (c === "^" || c === "$") fail(`an anchor "${c}" inside the pattern`);
    if (c === "*" || c === "+" || c === "?" || c === "{") fail(`a quantifier "${c}" with nothing to repeat`);
    if (c === "\\") { at++; return escape(false); }
    at++;
    return one(c.charCodeAt(0));
  }
  function escape(inClass: boolean): Re {
    const c = source[at];
    if (c === undefined) return fail("a trailing backslash");
    at++;
    switch (c) {
      case "d": return { kind: "cls", ranges: DIGIT, neg: false };
      case "D": return { kind: "cls", ranges: DIGIT, neg: true };
      case "w": return { kind: "cls", ranges: WORD, neg: false };
      case "W": return { kind: "cls", ranges: WORD, neg: true };
      case "s": return { kind: "cls", ranges: SPACE, neg: false };
      case "S": return { kind: "cls", ranges: SPACE, neg: true };
      case "n": return one(10);
      case "r": return one(13);
      case "t": return one(9);
      case "v": return one(11);
      case "f": return one(12);
      case "b": return inClass ? one(8) : fail("a word boundary \\b");
      case "B": return fail("a word boundary \\B");
    }
    if (/[0-9]/.test(c)) return c === "0" && !/[0-9]/.test(source[at] ?? "") ? one(0) : fail("a backreference");
    if (/[A-Za-z]/.test(c)) return fail(`the escape \\${c}`);
    return one(c.charCodeAt(0)); // an escaped syntax character: itself
  }
  function charClass(): Re {
    at++;
    const neg = source[at] === "^";
    if (neg) at++;
    const ranges: Array<readonly [number, number]> = [];
    let first = true;
    while (at < source.length && (source[at] !== "]" || false)) {
      if (source[at] === "]" && !first) break;
      first = false;
      const lo = classAtom();
      if (source[at] === "-" && source[at + 1] !== "]" && at + 1 < source.length) {
        at++;
        const hi = classAtom();
        if (lo.length !== 1 || hi.length !== 1) fail("a class range over a class escape");
        if (hi[0]![0] < lo[0]![0]) fail("a class range out of order");
        ranges.push([lo[0]![0], hi[0]![1]]);
      } else ranges.push(...lo);
      if (source[at] === "]") break;
    }
    if (source[at] !== "]") fail("an unclosed class");
    at++;
    return { kind: "cls", ranges, neg };
  }
  function classAtom(): ReadonlyArray<readonly [number, number]> {
    const c = source[at]!;
    if (c === "\\") { at++; const r = escape(true); return r.kind === "cls" && !r.neg ? r.ranges : fail("a negated class escape inside a class"); }
    at++;
    return [[c.charCodeAt(0), c.charCodeAt(0)]];
  }

  const re = alternation();
  if (at !== end) fail(`an unmatched "${source[at]}"`);
  return { re, bol, eol };
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** The pattern as a Dafny `JsRe` term. */
export function dafnyTerm(re: Re): string {
  switch (re.kind) {
    case "eps": return "JsRe.Eps";
    case "cls": return `JsRe.Cls([${re.ranges.map(([lo, hi]) => `(${lo}, ${hi})`).join(", ")}], ${re.neg})`;
    case "cat": return `JsRe.Cat(${dafnyTerm(re.a)}, ${dafnyTerm(re.b)})`;
    case "alt": return `JsRe.Alt(${dafnyTerm(re.a)}, ${dafnyTerm(re.b)})`;
    case "star": return `JsRe.Star(${dafnyTerm(re.a)})`;
  }
}

// ── Patterns a module tests ──────────────────────────────────

const patterns = new Map<string, Pattern>();

/** The Dafny function deciding `/source/flags.test(s)`; a pattern outside the subset throws RegexRefused. */
export function regexTestName(source: string, flags: string): string {
  const pattern = parsePattern(source, flags);
  let hash = 2166136261;
  for (const c of `${flags}/${source}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const name = `JsRegexTest_${hash.toString(16).padStart(8, "0")}`;
  patterns.set(name, pattern);
  return name;
}

export function isRegexTestName(name: string): boolean {
  return /^JsRegexTest_[0-9a-f]{8}$/.test(name);
}

/** The core and one `JsRegexTest_<hash>` per pattern seen: `JsTest`, which the core proves is `JsSearch`. */
export function regexPreamble(): string {
  const tests = [...patterns].map(([name, p]) =>
    `function ${name}(s: string): bool\n  ensures ${name}(s) <==> JsSearch(${dafnyTerm(p.re)}, JsCodeUnits(s), ${p.bol}, ${p.eol})\n{\n  JsTestCorrect(${dafnyTerm(p.re)}, JsCodeUnits(s), ${p.bol}, ${p.eol});\n  JsTest(${dafnyTerm(p.re)}, JsCodeUnits(s), ${p.bol}, ${p.eol})\n}`);
  return [REGEX_CORE, ...tests].join("\n\n");
}

export const REGEX_CORE = `// A regular-expression core over UTF-16 code units: the language a pattern denotes, a derivative matcher, and their
// equivalence. JavaScript's RegExp.prototype.test on a pattern without backreferences or lookaround answers whether
// some substring is in the language; anchors fix the substring's ends.
datatype JsRe = Nothing | Eps | Cls(ranges: seq<(int, int)>, neg: bool) | Cat(a: JsRe, b: JsRe) | Alt(a: JsRe, b: JsRe) | Star(a: JsRe)

predicate JsInRanges(ranges: seq<(int, int)>, c: int)
  decreases |ranges|
{
  |ranges| > 0 && (ranges[0].0 <= c <= ranges[0].1 || JsInRanges(ranges[1..], c))
}

predicate JsInCls(ranges: seq<(int, int)>, neg: bool, c: int) {
  JsInRanges(ranges, c) != neg
}

predicate JsInLang(r: JsRe, s: seq<int>)
  decreases |s|, r
{
  match r
  case Nothing => false
  case Eps => |s| == 0
  case Cls(rs, neg) => |s| == 1 && JsInCls(rs, neg, s[0])
  case Cat(a, b) => exists k :: 0 <= k <= |s| && JsInLang(a, s[..k]) && JsInLang(b, s[k..])
  case Alt(a, b) => JsInLang(a, s) || JsInLang(b, s)
  case Star(a) => |s| == 0 || exists k :: 1 <= k <= |s| && JsInLang(a, s[..k]) && JsInLang(Star(a), s[k..])
}

function JsNullable(r: JsRe): bool {
  match r
  case Nothing => false
  case Eps => true
  case Cls(_, _) => false
  case Cat(a, b) => JsNullable(a) && JsNullable(b)
  case Alt(a, b) => JsNullable(a) || JsNullable(b)
  case Star(_) => true
}

function JsDeriv(r: JsRe, c: int): JsRe {
  match r
  case Nothing => Nothing
  case Eps => Nothing
  case Cls(rs, neg) => if JsInCls(rs, neg, c) then Eps else Nothing
  case Cat(a, b) => if JsNullable(a) then Alt(Cat(JsDeriv(a, c), b), JsDeriv(b, c)) else Cat(JsDeriv(a, c), b)
  case Alt(a, b) => Alt(JsDeriv(a, c), JsDeriv(b, c))
  case Star(a) => Cat(JsDeriv(a, c), Star(a))
}

function JsMatch(r: JsRe, s: seq<int>): bool
  decreases |s|
{
  if |s| == 0 then JsNullable(r) else JsMatch(JsDeriv(r, s[0]), s[1..])
}

lemma JsNullableIsEmpty(r: JsRe)
  ensures JsNullable(r) <==> JsInLang(r, [])
{
  match r
  case Cat(a, b) => {
    JsNullableIsEmpty(a); JsNullableIsEmpty(b);
    var e: seq<int> := [];
    assert e[..0] == e && e[0..] == e;
    if JsNullable(r) { assert JsInLang(a, e[..0]) && JsInLang(b, e[0..]); }
  }
  case Alt(a, b) => JsNullableIsEmpty(a); JsNullableIsEmpty(b);
  case _ =>
}

lemma JsDerivCorrect(r: JsRe, c: int, s: seq<int>)
  ensures JsInLang(JsDeriv(r, c), s) <==> JsInLang(r, [c] + s)
  decreases r, |s|
{
  var cs := [c] + s;
  match r
  case Nothing =>
  case Eps =>
  case Cls(rs, neg) =>
  case Alt(a, b) => JsDerivCorrect(a, c, s); JsDerivCorrect(b, c, s);
  case Cat(a, b) => {
    // => : a split of the derivative is a split of [c] + s
    if JsInLang(Cat(JsDeriv(a, c), b), s) {
      var k :| 0 <= k <= |s| && JsInLang(JsDeriv(a, c), s[..k]) && JsInLang(b, s[k..]);
      JsDerivCorrect(a, c, s[..k]);
      assert cs[..k + 1] == [c] + s[..k] && cs[k + 1..] == s[k..];
    }
    if JsNullable(a) && JsInLang(JsDeriv(b, c), s) {
      JsDerivCorrect(b, c, s); JsNullableIsEmpty(a);
      assert cs[..0] == [] && cs[0..] == cs;
    }
    // <= : a split of [c] + s is empty-first or takes c into a
    if JsInLang(r, cs) {
      var k :| 0 <= k <= |cs| && JsInLang(a, cs[..k]) && JsInLang(b, cs[k..]);
      if k == 0 {
        assert cs[..0] == []; JsNullableIsEmpty(a); assert cs[0..] == cs; JsDerivCorrect(b, c, s);
      } else {
        assert cs[..k] == [c] + s[..k - 1] && cs[k..] == s[k - 1..];
        JsDerivCorrect(a, c, s[..k - 1]);
      }
    }
  }
  case Star(a) => {
    if JsInLang(Cat(JsDeriv(a, c), Star(a)), s) {
      var k :| 0 <= k <= |s| && JsInLang(JsDeriv(a, c), s[..k]) && JsInLang(Star(a), s[k..]);
      JsDerivCorrect(a, c, s[..k]);
      assert cs[..k + 1] == [c] + s[..k] && cs[k + 1..] == s[k..];
    }
    if JsInLang(r, cs) {
      var k :| 1 <= k <= |cs| && JsInLang(a, cs[..k]) && JsInLang(Star(a), cs[k..]);
      assert cs[..k] == [c] + s[..k - 1] && cs[k..] == s[k - 1..];
      JsDerivCorrect(a, c, s[..k - 1]);
    }
  }
}

lemma JsMatchCorrect(r: JsRe, s: seq<int>)
  ensures JsMatch(r, s) <==> JsInLang(r, s)
  decreases |s|
{
  if |s| == 0 { JsNullableIsEmpty(r); }
  else {
    JsMatchCorrect(JsDeriv(r, s[0]), s[1..]);
    JsDerivCorrect(r, s[0], s[1..]);
    assert [s[0]] + s[1..] == s;
  }
}

// JsAny code unit: the negated empty class.
const JsAny: JsRe := Cls([], true)

lemma JsAnyStar(s: seq<int>)
  ensures JsInLang(Star(JsAny), s)
  decreases |s|
{
  if |s| > 0 {
    JsAnyStar(s[1..]);
    assert s[..1] == [s[0]] && JsInLang(JsAny, s[..1]);
    assert JsInLang(Star(JsAny), s[1..]);
  }
}

/** Some substring s[i..j] is in r's language; \`bol\` fixes i to 0 (\`^\`), \`eol\` fixes j to |s| (\`$\`). */
predicate JsSearch(r: JsRe, s: seq<int>, bol: bool, eol: bool) {
  exists i, j :: 0 <= i <= j <= |s| && (bol ==> i == 0) && (eol ==> j == |s|) && JsInLang(r, s[i..j])
}

function JsWrap(r: JsRe, bol: bool, eol: bool): JsRe {
  Cat(if bol then Eps else Star(JsAny), Cat(r, if eol then Eps else Star(JsAny)))
}

lemma JsWrapCorrect(r: JsRe, s: seq<int>, bol: bool, eol: bool)
  ensures JsInLang(JsWrap(r, bol, eol), s) <==> JsSearch(r, s, bol, eol)
{
  var p := if bol then Eps else Star(JsAny);
  var q := if eol then Eps else Star(JsAny);
  if JsInLang(JsWrap(r, bol, eol), s) {
    var k :| 0 <= k <= |s| && JsInLang(p, s[..k]) && JsInLang(Cat(r, q), s[k..]);
    var t := s[k..];
    var m :| 0 <= m <= |t| && JsInLang(r, t[..m]) && JsInLang(q, t[m..]);
    assert t[..m] == s[k..k + m];
    assert bol ==> k == 0;
    assert eol ==> k + m == |s|;
    assert JsInLang(r, s[k..k + m]);
  }
  if JsSearch(r, s, bol, eol) {
    var i, j :| 0 <= i <= j <= |s| && (bol ==> i == 0) && (eol ==> j == |s|) && JsInLang(r, s[i..j]);
    var t := s[i..];
    assert t[..j - i] == s[i..j];
    if !eol { JsAnyStar(t[j - i..]); } else { assert t[j - i..] == []; }
    assert JsInLang(q, t[j - i..]);
    assert JsInLang(Cat(r, q), t);
    if !bol { JsAnyStar(s[..i]); } else { assert s[..i] == []; }
    assert JsInLang(p, s[..i]);
  }
}

/** \`RegExp.prototype.test\` on the pattern: the derivative matcher over the wrapped pattern. */
function JsTest(r: JsRe, s: seq<int>, bol: bool, eol: bool): bool {
  JsMatch(JsWrap(r, bol, eol), s)
}

lemma JsTestCorrect(r: JsRe, s: seq<int>, bol: bool, eol: bool)
  ensures JsTest(r, s, bol, eol) <==> JsSearch(r, s, bol, eol)
{
  JsMatchCorrect(JsWrap(r, bol, eol), s);
  JsWrapCorrect(r, s, bol, eol);
}

/** A Dafny string's UTF-16 code units. */
function JsCodeUnits(s: string): seq<int> {
  seq(|s|, i requires 0 <= i < |s| => s[i] as int)
}
`;

/** `test` by the language semantics the Dafny preamble proves its matcher equal to: some substring with the anchored
 *  ends is in the pattern's language. For differential tests against the native RegExp. */
export function testPattern(p: Pattern, s: string): boolean {
  const memo = new Map<Re, Map<number, boolean>>();
  const go = (r: Re, i: number, j: number): boolean => {
    let table = memo.get(r);
    if (table === undefined) memo.set(r, table = new Map());
    const key = i * (s.length + 1) + j;
    const hit = table.get(key);
    if (hit !== undefined) return hit;
    let out = false;
    switch (r.kind) {
      case "eps": out = i === j; break;
      case "cls": out = j === i + 1 && r.ranges.some(([lo, hi]) => lo <= s.charCodeAt(i) && s.charCodeAt(i) <= hi) !== r.neg; break;
      case "cat": for (let k = i; k <= j && !out; k++) out = go(r.a, i, k) && go(r.b, k, j); break;
      case "alt": out = go(r.a, i, j) || go(r.b, i, j); break;
      case "star": out = i === j; for (let k = i + 1; k <= j && !out; k++) out = go(r.a, i, k) && go(r, k, j); break;
    }
    table.set(key, out);
    return out;
  };
  for (let i = 0; i <= s.length; i++) {
    if (p.bol && i > 0) break;
    for (let j = i; j <= s.length; j++) if ((!p.eol || j === s.length) && go(p.re, i, j)) return true;
  }
  return false;
}
