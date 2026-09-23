/**
 * Render a Cube.dev JavaScript model file (cube('Name', { ... })) into
 * markdown - one section per cube, its backing table, a measures table,
 * and a dimensions table.
 *
 * Cube model files come in two real formats that need genuinely different
 * parsing strategies (YAML cube.yml files would parse the same way the
 * `yaml`-backed openapi renderer does), and this renderer only tackles the
 * JavaScript one, built and tested against real cube files (see
 * examples/example-cube.js, adapted from geo-automation's cube/model/cubes/ -
 * customers.js, content.js, keywords.js and benchmarks.js were all read to
 * design this, not just the one committed as the example).
 *
 * Those real files rule out a plain-regex/line-scanning approach like the
 * Prisma renderer's: they contain `//` comments, template literals with
 * `${CUBE}` interpolation, and (in pre_aggregations) bare identifier
 * references like `Benchmarks.citation_rate` that aren't string literals.
 * That's genuinely arbitrary-enough JavaScript that hand-rolled scanning
 * would be guessing at edge cases - so this parses the file with `acorn`
 * (a real, dependency-free JS parser) into an AST and walks it, rather
 * than either regex-scanning or `eval`-ing untrusted-ish source.
 *
 * Handles: one or more `cube('Name', {...})` calls per file, `sql_table`,
 * `data_source`, `measures` (type, sql, format, filters), `dimensions`
 * (type, sql, primary_key). Values are read from object/array/string/
 * boolean/number literals; a template literal's raw source text is shown
 * as-is (e.g. `` `${CUBE}.status = 'active'` ``) rather than evaluated,
 * since `CUBE` isn't a real binding here and the literal expression text
 * is what's actually useful in a docs table anyway. Any value shape this
 * doesn't specifically recognize (e.g. the bare `Benchmarks.citation_rate`
 * identifiers inside pre_aggregations) falls back to its raw source text
 * rather than throwing.
 *
 * Does NOT handle: `segments`, `pre_aggregations`, `joins` - present in
 * some of the real files this was tested against, but outside the
 * "field + type + description" data-catalogue shape this project's
 * renderers share; multiple cubes referencing each other; computed
 * property keys or spread syntax in the config object.
 */
import { readFile } from "node:fs/promises";
import * as acorn from "acorn";
import { buildToc, parseBoolOption, scalarIcon, type RenderOptions } from "./base.js";

/** Stamped into rendered output as frontmatter by the CLI, and used by
 * publish-tree - the single source of truth for this format's icon. */
export const ICON = "🧊";

type Node = acorn.Node & Record<string, any>;

/** Evaluates a literal-ish AST node to a plain JS value. Falls back to the
 * node's raw source text for anything not specifically handled (template
 * literals, and any other expression shape - identifiers, member
 * expressions, etc. - this doesn't need to understand semantically). */
function astToValue(node: Node | undefined, source: string): any {
  if (!node) return undefined;
  switch (node.type) {
    case "Literal":
      return node.value;
    case "ObjectExpression": {
      const obj: Record<string, any> = {};
      for (const prop of node.properties as Node[]) {
        if (prop.type !== "Property") continue;
        const key = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
        obj[key] = astToValue(prop.value, source);
      }
      return obj;
    }
    case "ArrayExpression":
      return (node.elements as (Node | null)[]).map((el) => (el ? astToValue(el, source) : null));
    case "TemplateLiteral":
      // Raw source text, minus the literal's own surrounding backticks -
      // callers that display this as code wrap it in backticks themselves,
      // and keeping the value plain avoids doubled-backtick code spans.
      return source.slice(node.start + 1, node.end - 1);
    default:
      // TemplateLiteral, Identifier, MemberExpression, CallExpression, ... -
      // show the literal source text rather than guessing at evaluation.
      return source.slice(node.start, node.end);
  }
}

function findCubeCalls(program: Node): Node[] {
  return (program.body as Node[])
    .filter((stmt) => stmt.type === "ExpressionStatement")
    .map((stmt) => stmt.expression as Node)
    .filter(
      (expr): expr is Node =>
        expr.type === "CallExpression" && expr.callee.type === "Identifier" && expr.callee.name === "cube"
    );
}

function renderMeasures(measures: Record<string, any>): string {
  const names = Object.keys(measures);
  if (names.length === 0) return "*(no measures)*";
  const rows = ["| Measure | Type | Expression | Description |", "|---|---|---|---|"];
  for (const name of names) {
    const m = measures[name] ?? {};
    const type = m.type ?? "";
    const expression = m.sql ?? (Array.isArray(m.filters) ? m.filters.map((f: any) => f?.sql).filter(Boolean).join("; ") : "");
    const desc = m.title || m.description || "";
    rows.push(`| \`${name}\` | ${type} | ${expression ? `\`${expression}\`` : ""} | ${desc} |`);
  }
  return rows.join("\n");
}

function renderDimensions(dimensions: Record<string, any>): string {
  const names = Object.keys(dimensions);
  if (names.length === 0) return "*(no dimensions)*";
  const rows = ["| Dimension | Type | Column | Primary Key |", "|---|---|---|---|"];
  for (const name of names) {
    const d = dimensions[name] ?? {};
    const type = d.type ?? "";
    const icon = type ? scalarIcon(type) : "";
    const column = d.sql ?? "";
    rows.push(`| \`${name}\` | ${icon} ${type} | ${column ? `\`${column}\`` : ""} | ${d.primary_key ? "✓" : ""} |`);
  }
  return rows.join("\n");
}

function renderCube(nameNode: Node, config: Record<string, any>, source: string): string {
  const name = astToValue(nameNode, source);
  const out = [`## ${name} (cube)`, ""];

  const sqlTable = config.sql_table;
  const dataSource = config.data_source;
  if (sqlTable || dataSource) {
    const parts = [];
    if (sqlTable) parts.push(`**Backing table:** \`${sqlTable}\``);
    if (dataSource) parts.push(`(data source: \`${dataSource}\`)`);
    out.push(parts.join(" "), "");
  }

  out.push("**Measures**", "", renderMeasures(config.measures ?? {}), "");
  out.push("**Dimensions**", "", renderDimensions(config.dimensions ?? {}), "");

  return out.join("\n");
}

export async function render(path: string, options: RenderOptions = {}): Promise<string> {
  const source = await readFile(path, "utf-8");
  const program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node;
  const cubeCalls = findCubeCalls(program);

  const docTitle = options.title || "Cube Catalogue";
  const out = [`# ${docTitle}`, ""];

  const cubes = cubeCalls.map((call) => {
    const [nameNode, configNode] = call.arguments as Node[];
    const config = astToValue(configNode, source) ?? {};
    return { nameNode, config };
  });

  if (parseBoolOption(options.toc, true) && cubes.length > 0) {
    const headings = cubes.map((c) => `${astToValue(c.nameNode, source)} (cube)`);
    out.push(buildToc(headings));
  }

  for (const { nameNode, config } of cubes) {
    out.push(renderCube(nameNode, config, source));
  }

  return out.join("\n");
}
