import { readFileSync, writeFileSync } from "node:fs";
const css = readFileSync(new URL("../refs/live-app.css", import.meta.url), "utf8");
const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
writeFileSync(
  new URL("./index.html", import.meta.url),
  tpl.replace("/*__LIVE_APP_CSS__*/", () => css),
);
console.log("wrote index.html");
