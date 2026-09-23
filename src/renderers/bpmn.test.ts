import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { render, extractProcessSummaries } from "./bpmn.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "example-bpmn.bpmn");

const BUSINESS_RULE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="content-classification" name="Content Classification" isExecutable="true">
    <bpmn:businessRuleTask id="Task_Classify" name="Classify content">
      <bpmn:extensionElements>
        <zeebe:calledDecision decisionId="jedi_or_sith" resultVariable="classification" />
      </bpmn:extensionElements>
    </bpmn:businessRuleTask>
  </bpmn:process>
</bpmn:definitions>
`;

async function withTempFile<T>(name: string, contents: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "outline-render-bpmn-"));
  const file = path.join(dir, name);
  await writeFile(file, contents);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("renders one section per process, named by process name", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Content Approval \(process\)/);
});

test("lists each service task with its Zeebe task type and retries", async () => {
  const out = await render(EXAMPLE);
  // These come from <zeebe:taskDefinition type="..." retries="..." /> inside
  // <bpmn:extensionElements> - the Camunda 8-specific piece this renderer
  // targets, as opposed to Camunda 7's camunda: namespace attributes.
  assert.match(out, /\| Post draft to CMS \| `post-draft-to-cms` \| 3 \|/);
  assert.match(out, /\| Send approval email \| `send-approval-email` \| 3 \|/);
  assert.match(out, /\| Publish content \| `publish-content` \| 3 \|/);
});

test("does not list non-service-task elements (gateways, catch events) as service tasks", async () => {
  const out = await render(EXAMPLE);
  assert.ok(!out.includes("Approved?"));
  assert.ok(!out.includes("Wait for approval"));
});

test("toc included by default", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Contents/);
  assert.ok(out.indexOf("## Contents") < out.indexOf("## Content Approval"));
  assert.match(out, /- \[Content Approval \(process\)\]\(#h-content-approval-process\)/);
});

test("toc can be disabled explicitly", async () => {
  const out = await render(EXAMPLE, { toc: "no" });
  assert.doesNotMatch(out, /## Contents/);
});

test("process- and task-level documentation becomes descriptive text", async () => {
  // <bpmn:documentation> is a standard BPMN element with one unambiguous
  // shape (regardless of engine), so a small synthetic fixture is enough
  // here - unlike the service task shape, there's no engine-specific
  // guessing risk to validate against a real file for.
  const dir = await mkdtemp(path.join(tmpdir(), "outline-render-bpmn-"));
  const file = path.join(dir, "documented.bpmn");
  await writeFile(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="documented-process" name="Documented Process" isExecutable="true">
    <bpmn:documentation>This process handles the thing.</bpmn:documentation>
    <bpmn:serviceTask id="Task_1" name="Do the thing">
      <bpmn:documentation>Calls the internal API.</bpmn:documentation>
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="do-the-thing" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>
`
  );
  try {
    const out = await render(file);
    assert.match(out, /## Documented Process \(process\)\n\nThis process handles the thing\./);
    assert.match(out, /\| Do the thing \| `do-the-thing` \|  \| Calls the internal API\. \|/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a business rule task's called decision renders as the raw decision id when it's not resolved", async () => {
  // Standalone single-file rendering has no visibility into which DMN file
  // (if any) declares this decision - the fallback every render() call
  // without cross-ref data uses.
  await withTempFile("classify.bpmn", BUSINESS_RULE_XML, async (file) => {
    const out = await render(file);
    assert.match(out, /## Content Classification \(process\)/);
    assert.match(out, /\*\*Decisions used\*\*/);
    assert.match(out, /\| Classify content \| `jedi_or_sith` \| classification \|  \|/);
  });
});

test("a business rule task's called decision renders as a real link when resolveDecision resolves it", async () => {
  await withTempFile("classify.bpmn", BUSINESS_RULE_XML, async (file) => {
    const out = await render(file, {}, {
      resolveDecision: (decisionId) =>
        decisionId === "jedi_or_sith" ? { name: "Jedi or Sith", url: "https://wiki.example.com/doc/jedi-or-sith" } : undefined,
    });
    assert.match(out, /\| Classify content \| \[Jedi or Sith\]\(https:\/\/wiki\.example\.com\/doc\/jedi-or-sith\) \| classification \|  \|/);
  });
});

test("resolveDecision returning undefined for an unrelated id still falls back to the raw id", async () => {
  await withTempFile("classify.bpmn", BUSINESS_RULE_XML, async (file) => {
    const out = await render(file, {}, { resolveDecision: () => undefined });
    assert.match(out, /\| Classify content \| `jedi_or_sith` \| classification \|/);
  });
});

test("a process with only service tasks doesn't render a Decisions used section, and vice versa", async () => {
  const out = await render(EXAMPLE); // example-bpmn.bpmn has only service tasks
  assert.doesNotMatch(out, /\*\*Decisions used\*\*/);

  await withTempFile("classify.bpmn", BUSINESS_RULE_XML, async (file) => {
    const out2 = await render(file);
    assert.doesNotMatch(out2, /\*\*Service tasks\*\*/);
  });
});

test("extractProcessSummaries: reports each process's id/name and the decision ids its business rule tasks call", async () => {
  await withTempFile("classify.bpmn", BUSINESS_RULE_XML, async (file) => {
    const summaries = await extractProcessSummaries(file);
    assert.deepEqual(summaries, [
      { id: "content-classification", name: "Content Classification", calledDecisionIds: ["jedi_or_sith"] },
    ]);
  });
});

test("extractProcessSummaries: a process with no business rule tasks reports an empty list, not an error", async () => {
  const summaries = await extractProcessSummaries(EXAMPLE);
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0].calledDecisionIds, []);
});
