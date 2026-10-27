import { expect, test } from "bun:test";
import { markdownEditorCss } from "../src/index";

test("read-only tables scroll independently and keep intrinsic cell words", () => {
  const sheet = document.createElement("style");
  sheet.textContent = markdownEditorCss;
  document.head.append(sheet);
  const host = document.createElement("div");
  host.className = "sui-markdown-editor";
  host.setAttribute("data-readonly", "");
  host.innerHTML = '<div class="milkdown"><div class="ProseMirror"><div class="milkdown-table-block"><table><tr><th>Dimension</th><td>Monitor.claim</td></tr></table></div><pre class="sui-markdown-code"><code>--record</code></pre></div></div>';
  document.body.append(host);
  try {
    const wrapper = getComputedStyle(host.querySelector(".milkdown-table-block")!);
    const table = getComputedStyle(host.querySelector("table")!);
    const cell = getComputedStyle(host.querySelector("td")!);
    expect(wrapper.overflowX).toBe("auto");
    expect(table.tableLayout).toBe("auto");
    expect(table.overflow).toBe("visible");
    expect(cell.wordBreak).toBe("normal");
    expect(cell.overflowWrap).toBe("normal");
    expect(cell.minWidth).toBe("192px");
    expect(getComputedStyle(host.querySelector("pre")!).fontFamily).toContain("monospace");
  } finally { host.remove(); sheet.remove(); }
});
