/**
 * The contract every renderer implements. A renderer turns one structured
 * source file into one markdown string - nothing else. It doesn't know
 * where the markdown goes (Outline, a git commit, stdout for piping into
 * something else) and doesn't touch the network.
 *
 * Adding a new renderer:
 *   1. Create src/renderers/<name>.ts
 *   2. Implement render(path: string, options: RenderOptions): Promise<string> | string
 *   3. Register it in src/cli.ts's RENDERERS map
 *
 * That's the whole interface. Options are renderer-specific (openapi/prisma
 * both take `title` and `toc`; a future renderer might take different ones)
 * - the CLI passes through whatever --option flags it doesn't recognize
 * itself, so renderers can each define their own without touching the CLI's
 * argument parser.
 */
import outlineSlugify from "slugify";

export interface RenderOptions {
  title?: string;
  toc?: string;
  [key: string]: string | undefined;
}

export type Renderer = (path: string, options: RenderOptions) => Promise<string> | string;

/**
 * The CLI's pass-through option parser only knows `--flag value` pairs, not
 * bare boolean switches (see cli.ts), so `--toc no` arrives as the string
 * "no" rather than false. Renderers use this to interpret it. `defaultValue`
 * applies only when the flag was omitted entirely - an explicit value
 * always wins.
 */
export function parseBoolOption(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Turns heading text into the anchor slug Outline itself generates for
 * that heading - not a GitHub-style guess. An earlier version of this
 * function produced GitHub/CommonMark-style slugs (no prefix, different
 * punctuation handling), which silently produced dead links: Outline's
 * own heading anchors all carry an "h-" prefix and use a different
 * punctuation-removal set, confirmed by reading Outline's own
 * shared/editor/lib/headingToSlug.ts rather than guessing. Replicated
 * here using the same `slugify` package Outline uses internally, for
 * byte-for-byte fidelity with its charmap (e.g. "&" -> "and") rather than
 * a hand-rolled approximation that could drift from it.
 *
 * The HTML-entity escape Outline also applies (via lodash/es-toolkit's
 * `escape`) is reimplemented directly here rather than pulling in that
 * whole dependency for five fixed, unambiguous character mappings.
 */
export function slugify(heading: string): string {
  const slug = outlineSlugify(heading, {
    remove: /[!"#$%&'.()*+,/:;<=>?@[\]\\^_`{|}~]/g,
    lower: true,
  });
  const escaped = slug.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  return `h-${escaped}`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Renders a markdown table of contents linking to a flat list of H2
 * headings (e.g. tags in the OpenAPI renderer, models/enums in the Prisma
 * renderer). Duplicate headings get disambiguating suffixes (-1, -2, ...)
 * matching Outline's own per-heading dedup counter, so their anchors don't
 * collide. Note this counts duplicates only among the H2 headings passed
 * in here, not every heading in the document the way Outline's own
 * counter does - if the same text also appears as an H1/H3/etc. elsewhere
 * in a document, this won't account for that and the computed anchor
 * could be off by one. Not observed in any of this project's actual
 * output, so not solved for speculatively.
 */
export function buildToc(headings: string[], label = "Contents"): string {
  const lines = [`## ${label}`, ""];
  const seen = new Map<string, number>();
  for (const heading of headings) {
    let slug = slugify(heading);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count) slug = `${slug}-${count}`;
    lines.push(`- [${heading}](#${slug})`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Icons for the scalar/primitive types shared across the type systems this
 * project renders (OpenAPI's JSON Schema types, Prisma's scalar types).
 * Keyed lowercase - callers normalize before looking up. Deliberately just
 * the common scalars every renderer using this needs to recognize by name;
 * a renderer-specific "is this actually a reference to another
 * model/schema" check (relations, $refs) is a separate concern each
 * renderer decides for itself, since what counts as a reference differs by
 * format.
 */
const SCALAR_ICONS: Record<string, string> = {
  string: "🔤",
  int: "🔢",
  integer: "🔢",
  float: "🔢",
  decimal: "🔢",
  bigint: "🔢",
  number: "🔢",
  boolean: "✅",
  bool: "✅",
  datetime: "📅",
  date: "📅",
  time: "📅",
  json: "🧾",
  bytes: "🧬",
};

export const ARRAY_ICON = "📋";
export const RELATION_ICON = "🔗";
export const UNKNOWN_TYPE_ICON = "❓";

/** Looks up the icon for a scalar type name (case-insensitive), falling
 * back to UNKNOWN_TYPE_ICON for anything not in the common set above. */
export function scalarIcon(typeName: string): string {
  return SCALAR_ICONS[typeName.toLowerCase()] ?? UNKNOWN_TYPE_ICON;
}
