import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { render } from "./cube.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "example-cube.js");

test("renders one section per cube, named by the cube's first argument", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Customers \(cube\)/);
});

test("renders the backing table and data source", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\*\*Backing table:\*\* `customers` \(data source: `custdb`\)/);
});

test("renders measures with their type and SQL expression", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| `count` \| count \|  \|  \|/);
  // active_count's filters[0].sql is a template literal with ${CUBE}
  // interpolation - the raw expression text should show, not a crash, and
  // not evaluated (CUBE isn't a real binding anywhere near this renderer).
  assert.match(out, /\| `active_count` \| count \| `\$\{CUBE\}\.status = 'active'` \|/);
});

test("renders dimensions with a type icon and the backing column", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| `id` \| 🔤 string \| `_id` \| ✓ \|/); // primary_key
  assert.match(out, /\| `domain` \| 🔤 string \| `domain` \|  \|/);
  assert.match(out, /\| `created_at` \| 📅 time \| `createdAt` \|  \|/);
});

test("toc included by default", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Contents/);
  assert.ok(out.indexOf("## Contents") < out.indexOf("## Customers"));
  assert.match(out, /- \[Customers \(cube\)\]\(#h-customers-cube\)/);
});

test("toc can be disabled explicitly", async () => {
  const out = await render(EXAMPLE, { toc: "no" });
  assert.doesNotMatch(out, /## Contents/);
});

test("title override", async () => {
  const out = await render(EXAMPLE, { title: "Custom Title" });
  assert.ok(out.startsWith("# Custom Title"));
});

test("does not crash on pre_aggregations containing bare identifier references (e.g. Benchmarks.citation_rate)", async () => {
  // Regression guard for the real-world case this renderer was built
  // against: pre_aggregations blocks reference cube fields as bare
  // identifiers/member expressions, not string literals - astToValue must
  // fall back to raw source text for those rather than throwing, and this
  // renderer doesn't render pre_aggregations at all (out of scope), so the
  // whole file should just render its measures/dimensions normally.
  const source = `cube('WithPreAggs', {
  sql_table: 'things',
  measures: { count: { type: 'count' } },
  dimensions: { id: { sql: '_id', type: 'string', primary_key: true } },
  pre_aggregations: {
    monthly: {
      measures: [WithPreAggs.count],
      dimensions: [WithPreAggs.id],
      granularity: 'month',
    },
  },
});
`;
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const tmp = await mkdtemp(path.join(tmpdir(), "outline-render-cube-"));
  const tmpFile = path.join(tmp, "with-pre-aggs.js");
  await writeFile(tmpFile, source);
  try {
    const out = await render(tmpFile);
    assert.match(out, /## WithPreAggs \(cube\)/);
    assert.match(out, /\| `count` \| count \|/);
    assert.doesNotMatch(out, /pre_aggregations|monthly/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
