/**
 * Render a Prisma schema (schema.prisma) into markdown - one table per
 * `model`, one section per `enum`. Field-level `///` doc comments become
 * the Description column, which is the whole point of using this over just
 * dumping the schema file as a code block: teams that already write doc
 * comments in their Prisma schema get a real data catalogue for free.
 *
 * No dependencies - the Prisma schema DSL is regular enough to parse with
 * plain line scanning, no need for a real grammar parser.
 *
 * Handles: model/enum blocks, field name/type/optional(`?`)/array(`[]`),
 * inline attributes (@id, @unique, @default(...), @relation(...), @map,
 * @updatedAt), `///` doc comments directly above a model or field. The Type
 * column gets an icon per field: a relation/enum icon if the field's type
 * names another model or enum declared in this same file, otherwise a
 * scalar-type icon looked up by name (see renderers/base.ts's scalarIcon).
 *
 * Does NOT handle: `generator`/`datasource` blocks (not useful in a data
 * catalogue), composite types, multi-schema (`@@schema`), Prisma's newer
 * `type` blocks (embedded/composite types) - these would need genuinely
 * more parsing, not just more regex cases, so left out rather than
 * half-supported.
 */
import { readFile } from "node:fs/promises";
import { buildToc, parseBoolOption, scalarIcon, RELATION_ICON, type RenderOptions } from "./base.js";

/** Stamped into rendered output as frontmatter by the CLI, and used by
 * publish-tree - the single source of truth for this format's icon. */
export const ICON = "🗄️";

const FIELD_RE = /^\s*(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/;
const DOC_COMMENT_RE = /^\s*\/\/\/\s?(.*)$/;
const ATTR_START_RE = /@(\w+)/g;

type Block = { kind: "model" | "enum"; name: string; body: string; doc: string[] };

/**
 * Depth-aware attribute extraction - a plain \([^)]*\) regex breaks on
 * nested parens like @default(autoincrement()) or
 * @default(dbgenerated("gen_random_uuid()")).
 */
function extractAttrs(rest: string): string[] {
  const attrs: string[] = [];
  let i = 0;
  ATTR_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_START_RE.exec(rest)) !== null) {
    if (m.index < i) continue; // already consumed as part of a previous attribute's args
    const name = m[1];
    i = ATTR_START_RE.lastIndex;
    if (i < rest.length && rest[i] === "(") {
      let depth = 0;
      const start = i;
      while (i < rest.length) {
        if (rest[i] === "(") depth += 1;
        else if (rest[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      attrs.push(`@${name}${rest.slice(start, i)}`);
      ATTR_START_RE.lastIndex = i;
    } else {
      attrs.push(`@${name}`);
    }
  }
  return attrs;
}

function extractBlocks(schema: string): Block[] {
  const blocks: Block[] = [];
  const lines = schema.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(model|enum)\s+(\w+)\s*\{/);
    if (m) {
      const kind = m[1] as "model" | "enum";
      const name = m[2];
      const docLines: string[] = [];
      let j = i - 1;
      let docMatch: RegExpMatchArray | null;
      while (j >= 0 && (docMatch = lines[j].match(DOC_COMMENT_RE))) {
        docLines.unshift(docMatch[1]);
        j -= 1;
      }
      const bodyLines: string[] = [];
      let depth = 1;
      i += 1;
      while (i < lines.length && depth > 0) {
        depth += (lines[i].match(/\{/g)?.length ?? 0) - (lines[i].match(/\}/g)?.length ?? 0);
        if (depth > 0) bodyLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind, name, body: bodyLines.join("\n"), doc: docLines });
      continue;
    }
    i += 1;
  }
  return blocks;
}

/** A field's base type is a relation/enum reference (icon: RELATION_ICON)
 * if it names another model/enum declared in this same schema file,
 * otherwise it's a scalar looked up by name (icon: scalarIcon). */
function fieldTypeIcon(ftype: string, knownTypeNames: Set<string>): string {
  return knownTypeNames.has(ftype) ? RELATION_ICON : scalarIcon(ftype);
}

function renderModel(name: string, body: string, modelDoc: string[], knownTypeNames: Set<string>): string {
  const out = [`## ${name}`, ""];
  if (modelDoc.length) out.push(modelDoc.join(" "), "");

  const rows = ["| Field | Type | Modifiers | Description |", "|---|---|---|---|"];
  let pendingDoc: string[] = [];
  const relationsNoted: string[] = [];

  for (const line of body.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    const docM = line.match(DOC_COMMENT_RE);
    if (docM) {
      pendingDoc.push(docM[1]);
      continue;
    }
    if (stripped.startsWith("@@")) {
      // Block-level attribute (@@id, @@unique, @@map, @@index, ...) - not a
      // field, but worth surfacing since @@map often means "the real table
      // name differs from the model name".
      relationsNoted.push(stripped);
      pendingDoc = [];
      continue;
    }

    const m = line.match(FIELD_RE);
    if (!m) {
      pendingDoc = [];
      continue;
    }
    const [, fname, ftype, modifier, rest] = m;
    const attrs = extractAttrs(rest);
    const typeDisplay = `${ftype}${modifier ?? ""}`;
    const icon = fieldTypeIcon(ftype, knownTypeNames);
    const desc = pendingDoc.join(" ");
    pendingDoc = [];
    rows.push(`| \`${fname}\` | ${icon} ${typeDisplay} | ${attrs.join(", ")} | ${desc} |`);
  }

  out.push(rows.join("\n"));
  if (relationsNoted.length) {
    out.push("", "**Table-level attributes:** " + relationsNoted.map((r) => `\`${r}\``).join("; "));
  }
  out.push("");
  return out.join("\n");
}

function renderEnum(name: string, body: string, doc: string[]): string {
  const out = [`## ${name} (enum)`, ""];
  if (doc.length) out.push(doc.join(" "), "");
  const rows = ["| Value | Description |", "|---|---|"];
  let pendingDoc: string[] = [];
  for (const line of body.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    const docM = line.match(DOC_COMMENT_RE);
    if (docM) {
      pendingDoc.push(docM[1]);
      continue;
    }
    rows.push(`| \`${stripped}\` | ${pendingDoc.join(" ")} |`);
    pendingDoc = [];
  }
  out.push(rows.join("\n"), "");
  return out.join("\n");
}

export async function render(path: string, options: RenderOptions = {}): Promise<string> {
  const schema = await readFile(path, "utf-8");

  const docTitle = options.title || "Data Catalogue";
  const out = [`# ${docTitle}`, ""];

  const blocks = extractBlocks(schema);
  const knownTypeNames = new Set(blocks.map((b) => b.name));

  if (parseBoolOption(options.toc, true) && blocks.length > 0) {
    const headings = blocks.map((b) => (b.kind === "model" ? b.name : `${b.name} (enum)`));
    out.push(buildToc(headings));
  }

  for (const block of blocks) {
    out.push(
      block.kind === "model"
        ? renderModel(block.name, block.body, block.doc, knownTypeNames)
        : renderEnum(block.name, block.body, block.doc)
    );
  }

  return out.join("\n");
}
