import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "./markdownComponents.js";
/** @typedef {import("mdx/types").MDXContent} MDXContent */
/**
 * Render an MDX component to plain markdown text.
 *
 * Injects `markdownComponents` so headings, paragraphs, code blocks, etc.
 * render as markdown-formatted text instead of HTML tags.
 *
 * @param {MDXContent} Component
 * @param {Record<string, any>} [props]
 * @returns {string}
 */
export function renderMdx(Component, props = {}) {
    const element = React.createElement(Component, {
        ...props,
        components: {
            ...markdownComponents,
            ...props.components,
        },
    });
    return renderToStaticMarkup(element)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
