import React from "react";
/**
 * @param {any[]} ...parts
 */
function fragment(...parts) {
    return React.createElement(React.Fragment, null, ...parts);
}
/** @type {Record<string, React.FC<any>>} */
export const markdownComponents = {
    h1: ({ children }) => fragment("# ", children, "\n\n"),
    h2: ({ children }) => fragment("## ", children, "\n\n"),
    h3: ({ children }) => fragment("### ", children, "\n\n"),
    h4: ({ children }) => fragment("#### ", children, "\n\n"),
    h5: ({ children }) => fragment("##### ", children, "\n\n"),
    h6: ({ children }) => fragment("###### ", children, "\n\n"),
    p: ({ children }) => fragment(children, "\n\n"),
    blockquote: ({ children }) => fragment("> ", children, "\n"),
    hr: () => fragment("---\n\n"),
    ul: ({ children }) => fragment(children, "\n"),
    ol: ({ children }) => fragment(children, "\n"),
    li: ({ children }) => fragment("- ", children, "\n"),
    code: ({ children, className }) => {
        if (className) {
            const lang = className.replace("language-", "");
            return fragment("```", lang, "\n", children, "\n```\n\n");
        }
        return fragment("`", children, "`");
    },
    pre: ({ children }) => fragment(children),
    strong: ({ children }) => fragment("**", children, "**"),
    em: ({ children }) => fragment("*", children, "*"),
    a: ({ href, children }) => fragment("[", children, "](", href, ")"),
    br: () => fragment("\n"),
    img: ({ alt, src }) => fragment("![", alt ?? "", "](", src, ")"),
    table: ({ children }) => fragment(children, "\n"),
    thead: ({ children }) => fragment(children),
    tbody: ({ children }) => fragment(children),
    tr: ({ children }) => fragment("| ", children, "\n"),
    th: ({ children }) => fragment(children, " | "),
    td: ({ children }) => fragment(children, " | "),
    div: ({ children }) => fragment(children, "\n"),
    section: ({ children }) => fragment(children, "\n"),
    span: ({ children }) => fragment(children),
};
