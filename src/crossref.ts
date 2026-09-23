/**
 * Cross-references a batch of BPMN processes and DMN decisions being
 * published together: which decisions a process calls (shown on the
 * process's own page), and which processes call a given decision (shown
 * on the decision's page as "Used by").
 *
 * Resolution is always by the DMN decision's own declared `id` - matching
 * a `bpmn:BusinessRuleTask`'s `zeebe:calledDecision.decisionId` - never by
 * filename, path, or name. Confirmed against zeebe-bpmn-moddle's own
 * CalledDecision type descriptor (decisionId/resultVariable, nothing
 * path-shaped) before building this: a real Zeebe process calls a decision
 * by that semantic id regardless of which file either one lives in, so
 * that's the only reliable join key - the same rule Zeebe itself uses to
 * resolve the call at runtime, not a heuristic guess.
 *
 * This only produces correct links once every file's real Outline URL is
 * known, which happens after publishTree's own first pass creates/resolves
 * every document - see outline.ts's publishTree for where this is called.
 */
import path from "node:path";
import { extractProcessSummaries, type DecisionLink } from "./renderers/bpmn.js";
import { extractDecisionSummaries, type ProcessLink } from "./renderers/dmn.js";
import { slugify } from "./renderers/base.js";

export interface CrossRefSource {
  /** Absolute path to the .md file being published - the doc whose
   * Outline URL a cross-reference to this process/decision points at. */
  mdAbsPath: string;
  /** Absolute path to the original .bpmn/.dmn source this .md's content
   * is (re-)rendered from. Kind (bpmn vs dmn) is detected by extension. */
  sourceAbsPath: string;
}

export interface CrossRefResult {
  /** Per bpmn .md file: a resolver to pass as that render() call's
   * BpmnCrossRefInput.resolveDecision. */
  bpmnResolvers: Map<string, (decisionId: string) => DecisionLink | undefined>;
  /** Per dmn .md file: the usedBy map to pass as that render() call's
   * DmnCrossRefInput.usedBy. (The same shared map for every dmn file is
   * fine - render() only ever looks up the specific decision ids that
   * file actually declares.) */
  dmnUsedBy: Map<string, Map<string, ProcessLink[]>>;
}

function isBpmnSource(sourceAbsPath: string): boolean {
  return path.extname(sourceAbsPath).toLowerCase() === ".bpmn";
}

function isDmnSource(sourceAbsPath: string): boolean {
  return path.extname(sourceAbsPath).toLowerCase() === ".dmn";
}

export async function buildCrossRef(
  sources: CrossRefSource[],
  urlForMdPath: (mdAbsPath: string) => string
): Promise<CrossRefResult> {
  // Pass 1: every DMN decision's id -> {name, url} (url includes the
  // anchor for that decision's own heading, using the same slugify()
  // Outline's real heading-anchor algorithm uses elsewhere in this
  // project - so this lands on the specific decision, not just the top
  // of a multi-decision DMN doc).
  const decisionById = new Map<string, DecisionLink>();
  for (const { mdAbsPath, sourceAbsPath } of sources) {
    if (!isDmnSource(sourceAbsPath)) continue;
    const docUrl = urlForMdPath(mdAbsPath);
    for (const d of await extractDecisionSummaries(sourceAbsPath)) {
      decisionById.set(d.id, { name: d.name, url: `${docUrl}#${slugify(`${d.name} (decision)`)}` });
    }
  }

  // Pass 2: every BPMN process's decision calls, and the reverse
  // (decisionId -> processes that call it).
  const usedBy = new Map<string, ProcessLink[]>();
  const bpmnResolvers = new Map<string, (decisionId: string) => DecisionLink | undefined>();

  for (const { mdAbsPath, sourceAbsPath } of sources) {
    if (!isBpmnSource(sourceAbsPath)) continue;
    bpmnResolvers.set(mdAbsPath, (decisionId) => decisionById.get(decisionId));

    const docUrl = urlForMdPath(mdAbsPath);
    for (const p of await extractProcessSummaries(sourceAbsPath)) {
      const link: ProcessLink = { name: p.name, url: `${docUrl}#${slugify(`${p.name} (process)`)}` };
      for (const decisionId of p.calledDecisionIds) {
        if (!usedBy.has(decisionId)) usedBy.set(decisionId, []);
        usedBy.get(decisionId)!.push(link);
      }
    }
  }

  const dmnUsedBy = new Map<string, Map<string, ProcessLink[]>>();
  for (const { mdAbsPath, sourceAbsPath } of sources) {
    if (!isDmnSource(sourceAbsPath)) continue;
    dmnUsedBy.set(mdAbsPath, usedBy);
  }

  return { bpmnResolvers, dmnUsedBy };
}
