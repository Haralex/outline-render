/**
 * Render a BPMN 2.0 process definition (.bpmn) into markdown - one section
 * per `<bpmn:process>`, its `<bpmn:documentation>` notes (if any), and a
 * table of its service tasks.
 *
 * Built on bpmn-moddle (https://github.com/bpmn-io/bpmn-moddle) - the
 * schema-aware XML<->model layer bpmn-js itself is built on - plus the
 * zeebe-bpmn-moddle extension that teaches it to understand Zeebe's
 * `<zeebe:taskDefinition>` extension element as a typed object instead of
 * generic XML. Deliberately not bpmn-js itself: that additionally pulls in
 * diagram-js/tiny-svg/min-dom to render an interactive SVG diagram in a
 * browser DOM, none of which this text-extraction CLI needs. moddle gives
 * the same schema-correct parsing (spec-default hit policy, resolved
 * documentation text, typed extension elements) without any of the
 * rendering weight - confirmed by probing both against the real fixture
 * this renderer is tested against.
 *
 * Targets Camunda 8 / Zeebe specifically: service task "worker" identity in
 * a Zeebe process lives on `zeebe:TaskDefinition`, which is the piece that
 * differs by engine (Camunda 7 uses `camunda:topic`/`camunda:class`/
 * `camunda:delegateExpression` attributes on the task itself instead) and
 * the reason this doesn't try to guess at other engines. Built and tested
 * against a real file (see examples/example-bpmn.bpmn - adapted from a live
 * geo-automation process, with task names/types genericized to a plain CMS
 * draft/approval flow rather than naming the real service involved, but
 * otherwise the same real element shapes) plus community Camunda 8 example
 * processes, not speculatively - see README's "Adding a new renderer" for
 * why that matters here.
 *
 * Handles: multiple processes per file, process- and task-level
 * `<bpmn:documentation>`, `<bpmn:serviceTask>` + its `zeebe:TaskDefinition`,
 * `<bpmn:businessRuleTask>` + its `zeebe:calledDecision` (the element a
 * Zeebe process uses to call a DMN decision - confirmed against
 * zeebe-bpmn-moddle's own type descriptor: `decisionId`/`resultVariable`,
 * not a filename or path). A businessRuleTask's decision reference renders
 * as a real markdown link when the caller resolves it (see
 * BpmnCrossRefInput/render's third argument - used by publish-tree to
 * cross-reference a batch of bpmn+dmn files by decision id, not by any
 * name/path guessing), or as the raw decision id otherwise.
 *
 * Does NOT handle: Camunda 7's `camunda:` namespace attributes, user/manual
 * tasks, timers, boundary events, collaborations/pools/lanes, multi-instance
 * markers - none of these are represented in the example files this was
 * built against, so rather than guess at their shape they're left out until
 * there's a real file to design against.
 */
import { readFile } from "node:fs/promises";
import { BpmnModdle } from "bpmn-moddle";
import zeebeModdle from "zeebe-bpmn-moddle/resources/zeebe.json" with { type: "json" };
import { buildToc, parseBoolOption, type RenderOptions } from "./base.js";

const moddle = new BpmnModdle({ zeebe: zeebeModdle });

/** Stamped into rendered output as frontmatter by the CLI, and used by
 * publish-tree - the single source of truth for this format's icon. */
export const ICON = "🔀";

/** A resolved link to a DMN decision - name for the link text, url for the
 * href. `url` can be a real Outline URL or a relative markdown path with
 * an anchor; render() doesn't care which, it just emits `[name](url)`. */
export interface DecisionLink {
  name: string;
  url: string;
}

export interface BpmnCrossRefInput {
  /** Resolves a zeebe:calledDecision's decisionId to a link, if the
   * decision it refers to is known - e.g. because it's part of the same
   * publish-tree batch. Absent (or returning undefined for a given id)
   * means "render the raw decision id, no link" - the fallback that
   * single-file rendering (no cross-ref data available) always uses. */
  resolveDecision?: (decisionId: string) => DecisionLink | undefined;
}

/** A summary of one process's DMN dependencies, extracted without
 * rendering markdown - what the cross-reference phase needs to build its
 * decisionId -> {process} map, without re-parsing rendered output. */
export interface BpmnProcessSummary {
  id: string;
  name: string;
  calledDecisionIds: string[];
}

function documentationText(element: any): string {
  return (element.get("documentation") ?? [])
    .map((d: any) => (d.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function calledDecisionOf(task: any): any {
  const extensionValues = task.get("extensionElements")?.get("values") ?? [];
  return extensionValues.find((v: any) => v.$type === "zeebe:CalledDecision");
}

function renderProcess(process: any, crossRef: BpmnCrossRefInput): string {
  const name = process.name || process.id;
  const out = [`## ${name} (process)`, ""];

  const doc = documentationText(process);
  if (doc) {
    out.push(doc, "");
  }

  const flowElements = process.get("flowElements") ?? [];
  const serviceTasks = flowElements.filter((el: any) => el.$type === "bpmn:ServiceTask");
  const businessRuleTasks = flowElements.filter((el: any) => el.$type === "bpmn:BusinessRuleTask");

  if (serviceTasks.length === 0 && businessRuleTasks.length === 0) {
    out.push("*(no service or business rule tasks)*", "");
    return out.join("\n");
  }

  if (serviceTasks.length > 0) {
    out.push("**Service tasks**", "");
    const rows = ["| Task | Type | Retries | Description |", "|---|---|---|---|"];
    for (const task of serviceTasks) {
      const taskName = task.name || task.id;
      const extensionValues = task.get("extensionElements")?.get("values") ?? [];
      const taskDef = extensionValues.find((v: any) => v.$type === "zeebe:TaskDefinition");
      const type = taskDef?.type ?? "";
      const retries = taskDef?.retries ?? "";
      const desc = documentationText(task);
      rows.push(`| ${taskName} | \`${type}\` | ${retries} | ${desc} |`);
    }
    out.push(rows.join("\n"), "");
  }

  if (businessRuleTasks.length > 0) {
    out.push("**Decisions used**", "");
    const rows = ["| Task | Decision | Result Variable | Description |", "|---|---|---|---|"];
    for (const task of businessRuleTasks) {
      const taskName = task.name || task.id;
      const calledDecision = calledDecisionOf(task);
      const decisionId = calledDecision?.decisionId ?? "";
      const resultVariable = calledDecision?.resultVariable ?? "";
      const resolved = decisionId ? crossRef.resolveDecision?.(decisionId) : undefined;
      const decisionCell = resolved ? `[${resolved.name}](${resolved.url})` : `\`${decisionId}\``;
      const desc = documentationText(task);
      rows.push(`| ${taskName} | ${decisionCell} | ${resultVariable} | ${desc} |`);
    }
    out.push(rows.join("\n"), "");
  }

  return out.join("\n");
}

async function loadProcesses(path: string): Promise<any[]> {
  const xml = await readFile(path, "utf-8");
  const { rootElement } = await moddle.fromXML(xml);
  return (rootElement.get("rootElements") ?? []).filter((el: any) => el.$type === "bpmn:Process");
}

/** Extracts each process's id/name and the decision ids its business rule
 * tasks call, without rendering markdown - what a batch cross-reference
 * phase needs, built from the same real parsed structure render() uses
 * rather than re-deriving it from rendered text. */
export async function extractProcessSummaries(path: string): Promise<BpmnProcessSummary[]> {
  const processes = await loadProcesses(path);
  return processes.map((process) => {
    const businessRuleTasks = (process.get("flowElements") ?? []).filter(
      (el: any) => el.$type === "bpmn:BusinessRuleTask"
    );
    const calledDecisionIds = businessRuleTasks
      .map((task: any) => calledDecisionOf(task)?.decisionId)
      .filter((id: unknown): id is string => Boolean(id));
    return { id: process.id, name: process.name || process.id, calledDecisionIds };
  });
}

export async function render(
  path: string,
  options: RenderOptions = {},
  crossRef: BpmnCrossRefInput = {}
): Promise<string> {
  const processes = await loadProcesses(path);

  const docTitle = options.title || "Process Catalogue";
  const out = [`# ${docTitle}`, ""];

  if (parseBoolOption(options.toc, true) && processes.length > 0) {
    const headings = processes.map((p: any) => `${p.name || p.id} (process)`);
    out.push(buildToc(headings));
  }

  for (const process of processes) {
    out.push(renderProcess(process, crossRef));
  }

  return out.join("\n");
}
