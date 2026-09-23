import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildCrossRef } from "./crossref.js";

// Real example files under examples/crossref/ - two BPMN processes and two
// DMN decisions, deliberately set up to show both cross-reference shapes:
// content-tone.dmn is called by both processes (a "Used by" list with two
// entries), approval-priority.dmn is called by only one (a "Used by" list
// with one). No real BPMN in this org's repos calls a DMN decision yet
// (checked before crossref.ts was built), so these are realistic examples
// built for this purpose rather than a real cross-referenced pair - but the
// decisionId <-> zeebe:calledDecision shape itself is verified against
// zeebe-bpmn-moddle's real type descriptor, not guessed (see crossref.ts).
const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "crossref");
const CONTENT_APPROVAL_BPMN = path.join(EXAMPLES, "content-approval.bpmn");
const EDITORIAL_REVIEW_BPMN = path.join(EXAMPLES, "editorial-review.bpmn");
const CONTENT_TONE_DMN = path.join(EXAMPLES, "content-tone.dmn");
const APPROVAL_PRIORITY_DMN = path.join(EXAMPLES, "approval-priority.dmn");

const URLS: Record<string, string> = {
  "/out/content-approval.md": "https://wiki.example.com/doc/content-approval",
  "/out/editorial-review.md": "https://wiki.example.com/doc/editorial-review",
  "/out/content-tone.md": "https://wiki.example.com/doc/content-tone",
  "/out/approval-priority.md": "https://wiki.example.com/doc/approval-priority",
};

const ALL_SOURCES = [
  { mdAbsPath: "/out/content-approval.md", sourceAbsPath: CONTENT_APPROVAL_BPMN },
  { mdAbsPath: "/out/editorial-review.md", sourceAbsPath: EDITORIAL_REVIEW_BPMN },
  { mdAbsPath: "/out/content-tone.md", sourceAbsPath: CONTENT_TONE_DMN },
  { mdAbsPath: "/out/approval-priority.md", sourceAbsPath: APPROVAL_PRIORITY_DMN },
];

test("buildCrossRef: resolves a bpmn's called decision to the dmn doc's url + decision anchor", async () => {
  const { bpmnResolvers } = await buildCrossRef(ALL_SOURCES, (p) => URLS[p]);
  const resolve = bpmnResolvers.get("/out/content-approval.md");
  assert.ok(resolve);
  assert.deepEqual(resolve!("content_tone"), {
    name: "Content Tone",
    url: "https://wiki.example.com/doc/content-tone#h-content-tone-decision",
  });
  assert.deepEqual(resolve!("approval_priority"), {
    name: "Approval Priority",
    url: "https://wiki.example.com/doc/approval-priority#h-approval-priority-decision",
  });
});

test("buildCrossRef: a decision id with no matching DMN in the batch resolves to undefined, not an error", async () => {
  const { bpmnResolvers } = await buildCrossRef(
    [ALL_SOURCES[0], ALL_SOURCES[2]], // content-approval.bpmn without approval-priority.dmn in the batch
    (p) => URLS[p]
  );
  const resolve = bpmnResolvers.get("/out/content-approval.md");
  assert.equal(resolve!("approval_priority"), undefined);
});

test("buildCrossRef: a decision called by two processes lists both under 'used by'", async () => {
  const { dmnUsedBy } = await buildCrossRef(ALL_SOURCES, (p) => URLS[p]);
  const usedBy = dmnUsedBy.get("/out/content-tone.md")!.get("content_tone");
  assert.deepEqual(usedBy, [
    { name: "Content Approval", url: "https://wiki.example.com/doc/content-approval#h-content-approval-process" },
    { name: "Editorial Review", url: "https://wiki.example.com/doc/editorial-review#h-editorial-review-process" },
  ]);
});

test("buildCrossRef: a decision called by only one process lists just that one", async () => {
  const { dmnUsedBy } = await buildCrossRef(ALL_SOURCES, (p) => URLS[p]);
  const usedBy = dmnUsedBy.get("/out/approval-priority.md")!.get("approval_priority");
  assert.deepEqual(usedBy, [
    { name: "Content Approval", url: "https://wiki.example.com/doc/content-approval#h-content-approval-process" },
  ]);
});

test("buildCrossRef: a .md file with no .bpmn/.dmn counterpart in the batch is simply ignored", async () => {
  const result = await buildCrossRef([], () => "https://wiki.example.com/doc/whatever");
  assert.equal(result.bpmnResolvers.size, 0);
  assert.equal(result.dmnUsedBy.size, 0);
});
