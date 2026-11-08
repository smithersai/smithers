// What GitHub must show exactly as written once the server escapes it: every reviewer case, every ASCII punctuation
// character, and each Markdown and GitHub construct that could change what a reader sees. render-fixtures.mjs renders
// them through GitHub; render.test.ts checks the recorded answers.
const t = "a".repeat(43)
const punctuation = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter((c) => !/[A-Za-z0-9]/.test(c)).join("")

/** The sandbox repository GitHub renders references in. */
export const RENDER_CONTEXT = "codeplanesmithers/smithers-e2e-scratch"

export const RENDER_CASES = [
  punctuation,
  `**smm**_${t}`, `smm_**${t}**`, `sm**m**_${t}`, `smm_\`${t}\``, `smm\\_${t}`, `[sm](https://example.com)m_${t}`,
  `smm<!--x-->_${t}`, `smm<a title=">">_${t}</a>`, "<div>smm&lowbar;aaaa</div>", "<b>bold</b> <img src=x>", "&copy; &amp; &#36; &#x41;",
  "_/Users/someone/private.txt_", "~/**notes**", "~/`notes`", "/[home](https://example.com)/alice/private.txt",
  "ping @someone and @smithersai/team", "see #1 and GH-1 and codeplanesmithers/smithers-e2e-scratch#1", "commit 0123456789abcdef0123456789abcdef01234567",
  // A commit of the context repository, which GitHub resolves and would shorten into a link.
  "commit a877b78446d1879df196773d9cfaf461cbc247df and short a877b78",
  "https://example.com/x and www.example.com and someone@example.com", "<https://example.com>", ":smile: :+1:",
  "| a | b |\n|---|---|\n| 1 | 2 |", "# heading\n## two", "- one\n* two\n+ three\n1. four\n2) five", "> quote\n>> deeper",
  "```\nfence\n```", "~~~\nfence\n~~~", "    indented code", "\tindented with a tab", "line one\nline two\n\nparagraph two",
  "trailing two spaces  \nnext", "---\n***\n___", "[ref]: https://example.com\n[ref]", "![alt](https://example.com/x.png)", "- [ ] task\n- [x] done",
  "a ~~strike~~ b", "$x^2$ and $$y$$", "<details><summary>s</summary>x</details>", "\\\\ backslashes \\\\\\", "emoji 😀 and é and ünïcode",
]
