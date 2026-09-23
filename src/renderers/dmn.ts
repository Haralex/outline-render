/**
 * Render a DMN 1.x decision model (.dmn) into markdown - one section per
 * `<decision>`, its hit policy, and its decision table as a
 * `| input columns... | output columns... |` matrix (one row per rule).
 *
 * Built on dmn-moddle (https://github.com/bpmn-io/dmn-moddle) - the
 * schema-aware XML<->model layer dmn-js itself is built on - rather than
 * dmn-js, which additionally pulls in diagram-js/tiny-svg/min-dom to render
 * an interactive table/diagram in a browser DOM. moddle applies the DMN
 * spec's schema itself (e.g. defaulting hitPolicy to "UNIQUE" when the
 * attribute is absent, exactly per spec) rather than this code
 * reimplementing that logic.
 *
 * Built and tested against a real Camunda 8-flavoured DMN file (see
 * examples/example-decision.dmn, sourced from camunda-community-hub's
 * camunda-8-examples repo), not speculatively - see README's "Adding a new
 * renderer" for why that matters here.
 *
 * Handles: multiple decisions per file, multiple input/output columns,
 * hit policy.
 *
 * Does NOT handle: decision requirements diagrams / cross-decision
 * dependencies within DMN itself, literal expressions or FEEL boxed
 * expressions in place of a decision table, DMN's `itemDefinition` blocks -
 * left out until there's a real file that needs them. (Namespace-prefixed
 * exports, e.g. `<dmn:decision>`, work fine - moddle resolves elements by
 * namespace URI, not literal tag prefix, unlike an earlier hand-rolled
 * version of this renderer that only matched the unprefixed default-
 * namespace case the example file happens to use.)
 *
 * A decision *can* show which BPMN processes call it (a "Used by" line),
 * but only when the caller supplies that - a single DMN file has no way to
 * know which processes reference it, so this is never derived from the
 * file itself. See DmnCrossRefInput/render's third argument - used by
 * publish-tree to cross-reference a batch of bpmn+dmn files by decision id.
 */
import { readFile } from "node:fs/promises";
import { DmnModdle } from "dmn-moddle";
import { buildToc, parseBoolOption, type RenderOptions } from "./base.js";

const moddle = new DmnModdle();

/** Stamped into rendered output as frontmatter by the CLI, and used by
 * publish-tree - the single source of truth for this format's icon. */
export const ICON = "🎯";

/** A resolved link to a BPMN process - name for the link text, url for
 * the href. `url` can be a real Outline URL or a relative markdown path
 * with an anchor; render() doesn't care which. */
export interface ProcessLink {
  name: string;
  url: string;
}

export interface DmnCrossRefInput {
  /** Processes that call a given decision, keyed by that decision's own
   * id - e.g. because a businessRuleTask calling it is part of the same
   * publish-tree batch. No entry for a decision's id means no "Used by"
   * line - the fallback single-file rendering (no cross-ref data
   * available) always uses. */
  usedBy?: Map<string, ProcessLink[]>;
}

/** A summary of one decision's id/name, extracted without rendering
 * markdown - what the cross-reference phase needs to build its
 * decisionId -> {decision} map, without re-parsing rendered output. */
export interface DmnDecisionSummary {
  id: string;
  name: string;
}

function renderDecision(decision: any, usedBy: ProcessLink[] | undefined): string {
  const name = decision.name || decision.id;
  const out = [`## ${name} (decision)`, ""];

  if (usedBy && usedBy.length > 0) {
    out.push(`**Used by:** ${usedBy.map((p) => `[${p.name}](${p.url})`).join(", ")}`, "");
  }

  const table = decision.get("decisionLogic");
  if (!table || table.$type !== "dmn:DecisionTable") {
    out.push("*(no decision table)*", "");
    return out.join("\n");
  }

  out.push(`**Hit policy:** ${table.hitPolicy}`, "");

  const inputs = table.get("input") ?? [];
  const outputs = table.get("output") ?? [];
  const rules = table.get("rule") ?? [];

  const inputLabels = inputs.map((i: any) => i.label || i.id);
  const outputLabels = outputs.map((o: any) => o.label || o.name || o.id);
  const headers = [...inputLabels, ...outputLabels];

  const rows = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const rule of rules) {
    const inputEntries = (rule.get("inputEntry") ?? []).map((e: any) => (e.text ?? "").trim());
    const outputEntries = (rule.get("outputEntry") ?? []).map((e: any) => (e.text ?? "").trim());
    rows.push(`| ${[...inputEntries, ...outputEntries].join(" | ")} |`);
  }
  out.push(rows.join("\n"), "");

  return out.join("\n");
}

async function loadDecisions(path: string): Promise<{ rootElement: any; decisions: any[] }> {
  const xml = await readFile(path, "utf-8");
  const { rootElement } = await moddle.fromXML(xml);
  const decisions = (rootElement.get("drgElement") ?? []).filter((el: any) => el.$type === "dmn:Decision");
  return { rootElement, decisions };
}

/** Extracts each decision's id/name without rendering markdown - what a
 * batch cross-reference phase needs, built from the same real parsed
 * structure render() uses rather than re-deriving it from rendered text. */
export async function extractDecisionSummaries(path: string): Promise<DmnDecisionSummary[]> {
  const { decisions } = await loadDecisions(path);
  return decisions.map((d) => ({ id: d.id, name: d.name || d.id }));
}

export async function render(
  path: string,
  options: RenderOptions = {},
  crossRef: DmnCrossRefInput = {}
): Promise<string> {
  const { rootElement, decisions } = await loadDecisions(path);

  const docTitle = options.title || rootElement.name || "Decision Catalogue";
  const out = [`# ${docTitle}`, ""];

  if (parseBoolOption(options.toc, true) && decisions.length > 0) {
    const headings = decisions.map((d: any) => `${d.name || d.id} (decision)`);
    out.push(buildToc(headings));
  }

  for (const decision of decisions) {
    out.push(renderDecision(decision, crossRef.usedBy?.get(decision.id)));
  }

  return out.join("\n");
}
