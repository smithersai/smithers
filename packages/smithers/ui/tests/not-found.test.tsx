/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFound } from "../src/not-found";

test("absent routes and resources share a recovery link", () => {
  const back = <a href="/app">Back to chat</a>;
  const route = renderToStaticMarkup(<NotFound back={back} />);
  expect(route).toContain("Not found");
  expect(route).toContain('href="/app"');
  const issue = renderToStaticMarkup(<NotFound title="Issue not found" back={<a href="/o/r/issues">Issues</a>} />);
  expect(issue).toContain("Issue not found");
  expect(issue).toContain('href="/o/r/issues"');
});
