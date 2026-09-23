import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { render, extractDecisionSummaries } from "./dmn.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "example-decision.dmn");

test("renders one section per decision, named by decision name", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Jedi or Sith \(decision\)/);
});

test("defaults hit policy to UNIQUE when the attribute is absent", async () => {
  const out = await render(EXAMPLE);
  // The example file's <decisionTable> carries no hitPolicy attribute -
  // UNIQUE is the DMN spec's default in that case.
  assert.match(out, /\*\*Hit policy:\*\* UNIQUE/);
});

test("renders the decision table as an input/output matrix, one row per rule", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| Lightsaber color \| Jedi or Sith \|/);
  assert.match(out, /\| "blue" \| "Jedi" \|/);
  assert.match(out, /\| "green" \| "Jedi" \|/);
  assert.match(out, /\| "red" \| "Sith" \|/);
});

test("falls back to the definitions' name as the document title", async () => {
  const out = await render(EXAMPLE);
  // <definitions id="force_users" name="Force Users" ...> in the example file.
  assert.ok(out.startsWith("# Force Users"));
});

test("title override", async () => {
  const out = await render(EXAMPLE, { title: "Custom Title" });
  assert.ok(out.startsWith("# Custom Title"));
});

test("toc included by default", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Contents/);
  assert.ok(out.indexOf("## Contents") < out.indexOf("## Jedi or Sith"));
  assert.match(out, /- \[Jedi or Sith \(decision\)\]\(#h-jedi-or-sith-decision\)/);
});

test("toc can be disabled explicitly", async () => {
  const out = await render(EXAMPLE, { toc: "no" });
  assert.doesNotMatch(out, /## Contents/);
});

test("no Used by line when no cross-ref data is given (standalone single-file rendering)", async () => {
  const out = await render(EXAMPLE);
  assert.doesNotMatch(out, /\*\*Used by:\*\*/);
});

test("renders a Used by line linking to each process that calls this decision, keyed by decision id", async () => {
  const usedBy = new Map([
    [
      "demoDecision_jedi_or_sith",
      [
        { name: "Content Classification", url: "https://wiki.example.com/doc/content-classification" },
        { name: "Another Process", url: "https://wiki.example.com/doc/another-process" },
      ],
    ],
  ]);
  const out = await render(EXAMPLE, {}, { usedBy });
  assert.match(
    out,
    /## Jedi or Sith \(decision\)\n\n\*\*Used by:\*\* \[Content Classification\]\(https:\/\/wiki\.example\.com\/doc\/content-classification\), \[Another Process\]\(https:\/\/wiki\.example\.com\/doc\/another-process\)/
  );
});

test("a usedBy map with no entry for this decision's id still renders with no Used by line", async () => {
  const usedBy = new Map([["some-other-decision-id", [{ name: "X", url: "https://example.com" }]]]);
  const out = await render(EXAMPLE, {}, { usedBy });
  assert.doesNotMatch(out, /\*\*Used by:\*\*/);
});

test("extractDecisionSummaries: reports each decision's id and name", async () => {
  const summaries = await extractDecisionSummaries(EXAMPLE);
  assert.deepEqual(summaries, [{ id: "demoDecision_jedi_or_sith", name: "Jedi or Sith" }]);
});

test("handles namespace-prefixed exports (e.g. <dmn:decision>), not just the default namespace", async () => {
  // dmn-moddle resolves elements by namespace URI rather than literal tag
  // prefix, so a modeler that exports with a "dmn:" prefix (unlike the
  // example file, which uses the unprefixed default namespace) still
  // parses correctly.
  const dir = await mkdtemp(path.join(tmpdir(), "outline-render-dmn-"));
  const file = path.join(dir, "prefixed.dmn");
  await writeFile(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<dmn:definitions xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/" id="d1" name="Prefixed" namespace="http://example.com">
  <dmn:decision id="dec1" name="Prefixed Decision">
    <dmn:decisionTable id="dt1">
      <dmn:input id="in1" label="Foo">
        <dmn:inputExpression id="ie1" typeRef="string"><dmn:text>foo</dmn:text></dmn:inputExpression>
      </dmn:input>
      <dmn:output id="out1" label="Bar" />
      <dmn:rule id="r1">
        <dmn:inputEntry id="ie2"><dmn:text>"x"</dmn:text></dmn:inputEntry>
        <dmn:outputEntry id="oe1"><dmn:text>"y"</dmn:text></dmn:outputEntry>
      </dmn:rule>
    </dmn:decisionTable>
  </dmn:decision>
</dmn:definitions>
`
  );
  try {
    const out = await render(file);
    assert.match(out, /## Prefixed Decision \(decision\)/);
    assert.match(out, /\| Foo \| Bar \|/);
    assert.match(out, /\| "x" \| "y" \|/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
