import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { render } from "./openapi.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "example-openapi.yaml");

test("renders title and version", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /# Example Orders API/);
  assert.match(out, /\*\*Version:\*\* 1\.0\.0/);
});

test("title override", async () => {
  const out = await render(EXAMPLE, { title: "Custom Title" });
  assert.ok(out.startsWith("# Custom Title"));
});

test("ref resolution produces field table", async () => {
  const out = await render(EXAMPLE);
  // Order schema is reached via $ref from multiple responses - if ref
  // resolution is broken this table never appears.
  assert.match(out, /\| `status` \| 🔤 string \| ✓ \| One of pending, paid, shipped, cancelled\. \|/);
});

test("type column gets an icon per JSON Schema type", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| `id` \| 🔤 string \|/); // scalar
  assert.match(out, /\| `total_amount` \| 🔢 integer \|/); // scalar
  assert.match(out, /\| `account` \| 🔗 object \|/); // unresolved nested schema
});

test("nested array of ref renders without glued line", async () => {
  const out = await render(EXAMPLE);
  // Regression: "Array of:" used to be glued directly onto the same line as
  // the table (e.g. "array of: | Field | ..."), breaking markdown table
  // rendering - a table must start at the beginning of a line. Nested
  // inside a response block this gets re-indented, so the blank separator
  // line becomes whitespace-only rather than empty - still a valid blank
  // line per CommonMark, so allow for that here.
  assert.match(out, /Array of:\n\s*\n\s*\| Field/);
});

test("toc included by default", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Contents/);
  // The TOC must appear before the sections it links to.
  assert.ok(out.indexOf("## Contents") < out.indexOf("## Orders"));
  assert.match(out, /- \[Orders\]\(#h-orders\)/);
  assert.match(out, /## Orders/);
});

test("toc can be disabled explicitly", async () => {
  const out = await render(EXAMPLE, { toc: "no" });
  assert.doesNotMatch(out, /## Contents/);
});
