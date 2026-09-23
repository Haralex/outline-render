/**
 * Render an OpenAPI 3.x (Swagger) spec into markdown.
 *
 * Handles: paths grouped by tag, parameters, requestBody, responses, and
 * internal $ref resolution against components.schemas (recursive - a $ref
 * to a schema that itself contains further $refs gets those inlined too,
 * but circular refs are cut off with a plain "(circular reference)" note
 * rather than infinite-looping).
 *
 * Does NOT handle: external $refs (a $ref pointing at another file/URL),
 * oneOf/anyOf/allOf composition beyond a flat listing, callbacks, links.
 * Real specs may need those - this covers the common case, not the whole
 * OpenAPI spec.
 *
 * Type columns (schema properties and parameters) get an icon per type -
 * an array/object/scalar icon looked up by name, see renderers/base.ts.
 *
 * Uses the `yaml` package for .yaml/.yml specs (not needed for .json ones,
 * which use the built-in JSON.parse).
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ARRAY_ICON, RELATION_ICON, UNKNOWN_TYPE_ICON, buildToc, parseBoolOption, scalarIcon, type RenderOptions } from "./base.js";

/** Stamped into rendered output as frontmatter by the CLI, and used by
 * publish-tree - the single source of truth for this format's icon. */
export const ICON = "🔌";

type JsonObject = Record<string, any>;

/** propType is "array[X]", "object" (an unresolved/inline nested schema),
 * "any" (no type info), or a JSON Schema primitive. */
function typeIcon(propType: string): string {
  if (propType.startsWith("array[")) return ARRAY_ICON;
  if (propType === "object") return RELATION_ICON;
  if (propType === "any") return UNKNOWN_TYPE_ICON;
  return scalarIcon(propType);
}

async function loadSpec(path: string): Promise<JsonObject> {
  const raw = await readFile(path, "utf-8");
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return parseYaml(raw) as JsonObject;
  }
  return JSON.parse(raw);
}

/** Only supports internal refs: '#/components/schemas/Foo'. */
function resolveRef(spec: JsonObject, ref: string): JsonObject {
  if (!ref.startsWith("#/")) {
    return { description: `(external ref not resolved: ${ref})` };
  }
  let node: any = spec;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    node = node?.[part] ?? {};
  }
  return node;
}

function renderSchema(
  spec: JsonObject,
  schema: JsonObject | undefined,
  seen: Set<string> = new Set(),
  depth = 0
): string {
  if (!schema || Object.keys(schema).length === 0) return "*(none)*";
  if (schema.$ref) {
    const ref = schema.$ref as string;
    if (seen.has(ref)) return "*(circular reference)*";
    return renderSchema(spec, resolveRef(spec, ref), new Set([...seen, ref]), depth);
  }

  const schemaType = schema.type;
  if (schemaType === "object" || schema.properties) {
    const props: JsonObject = schema.properties ?? {};
    const required = new Set<string>(schema.required ?? []);
    if (Object.keys(props).length === 0) return "*(object, no properties defined)*";
    const lines = ["| Field | Type | Required | Description |", "|---|---|---|---|"];
    for (const [name, prop] of Object.entries(props) as [string, JsonObject][]) {
      const resolved = prop.$ref ? resolveRef(spec, prop.$ref) : prop;
      let propType = resolved.type ?? (prop.$ref ? "object" : "any");
      if (resolved.type === "array") {
        const items = resolved.items ?? {};
        const itemType = items.$ref
          ? resolveRef(spec, items.$ref).type ?? "object"
          : items.type ?? "any";
        propType = `array[${itemType}]`;
      }
      const desc = (resolved.description ?? "").replace(/\n/g, " ");
      lines.push(`| \`${name}\` | ${typeIcon(propType)} ${propType} | ${required.has(name) ? "✓" : ""} | ${desc} |`);
    }
    return lines.join("\n");
  }
  if (schemaType === "array") {
    const items = schema.items ?? {};
    return `Array of:\n\n${renderSchema(spec, items, seen, depth + 1)}`;
  }
  return `\`${schemaType ?? "any"}\`` + (schema.description ? ` — ${schema.description}` : "");
}

function renderParameters(spec: JsonObject, params: JsonObject[]): string {
  if (!params || params.length === 0) return "";
  const lines = ["| Name | In | Required | Type | Description |", "|---|---|---|---|---|"];
  for (let p of params) {
    p = p.$ref ? resolveRef(spec, p.$ref) : p;
    const schema = p.schema ?? {};
    const ptype = schema.type ?? "any";
    const desc = (p.description ?? "").replace(/\n/g, " ");
    lines.push(`| \`${p.name}\` | ${p.in ?? ""} | ${p.required ? "✓" : ""} | ${typeIcon(ptype)} ${ptype} | ${desc} |`);
  }
  return lines.join("\n");
}

function renderOperation(spec: JsonObject, method: string, path: string, op: JsonObject): string {
  const out = [`### \`${method.toUpperCase()}\` ${path}`, ""];
  if (op.summary) {
    out.push(`**${op.summary}**`, "");
  }
  if (op.description) {
    out.push(op.description, "");
  }

  const params = renderParameters(spec, op.parameters ?? []);
  if (params) {
    out.push("**Parameters**", "", params, "");
  }

  const requestBody = op.requestBody ?? {};
  if (requestBody && Object.keys(requestBody).length > 0) {
    out.push("**Request body**", "");
    for (const [contentType, content] of Object.entries<JsonObject>(requestBody.content ?? {})) {
      out.push(`_${contentType}_`, "", renderSchema(spec, content.schema ?? {}), "");
    }
  }

  const responses: JsonObject = op.responses ?? {};
  if (Object.keys(responses).length > 0) {
    out.push("**Responses**", "");
    for (const [status, resp] of Object.entries<JsonObject>(responses)) {
      out.push(`- \`${status}\` — ${resp.description ?? ""}`);
      for (const [contentType, content] of Object.entries<JsonObject>(resp.content ?? {})) {
        out.push("", `  _${contentType}_`, "");
        const schemaMd = renderSchema(spec, content.schema ?? {});
        out.push("  " + schemaMd.replace(/\n/g, "\n  "));
      }
    }
    out.push("");
  }

  return out.join("\n");
}

export async function render(path: string, options: RenderOptions = {}): Promise<string> {
  const spec = await loadSpec(path);
  const info: JsonObject = spec.info ?? {};
  const docTitle = options.title || info.title || "API Reference";
  const out = [`# ${docTitle}`, ""];
  if (info.description) {
    out.push(info.description, "");
  }
  if (info.version) {
    out.push(`**Version:** ${info.version}`, "");
  }

  // Group operations by tag (falling back to "General" for untagged ones)
  const byTag = new Map<string, [string, string, JsonObject][]>();
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const [p, pathItem] of Object.entries<JsonObject>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<JsonObject>(pathItem)) {
      if (!methods.includes(method)) continue;
      const tags: string[] = op.tags?.length ? op.tags : ["General"];
      for (const tag of tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push([method, p, op]);
      }
    }
  }

  const sortedTags = [...byTag.keys()].sort();

  if (parseBoolOption(options.toc, true) && sortedTags.length > 0) {
    out.push(buildToc(sortedTags));
  }

  for (const tag of sortedTags) {
    out.push(`## ${tag}`, "");
    for (const [method, p, op] of byTag.get(tag)!) {
      out.push(renderOperation(spec, method, p, op), "");
    }
  }

  return out.join("\n");
}
