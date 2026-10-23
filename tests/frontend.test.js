const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = fs.readFileSync(
  path.join(__dirname, "../public/styles.css"),
  "utf8",
);
const browserCode = fs.readFileSync(
  path.join(__dirname, "../public/app.js"),
  "utf8",
);

test("responsive grid and table wrappers can shrink inside mobile viewports", () => {
  assert.match(
    css,
    /\.stack\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
  );
  assert.match(css, /\.page\.stack\s*\{[^}]*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.table-wrap\s*\{[^}]*max-width:\s*100%/s);
});

test("browser-rendered content uses textContent and never HTML insertion", () => {
  assert.match(browserCode, /element\.textContent\s*=\s*text/);
  assert.doesNotMatch(browserCode, /\.innerHTML\s*=/);
});

test("review rejection collects a required comment in an inline form", () => {
  assert.match(browserCode, /review-rejection/);
  assert.match(browserCode, /comment\.required\s*=\s*true/);
  assert.doesNotMatch(browserCode, /window\.prompt\(/);
});
