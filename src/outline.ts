/**
 * Publish a local markdown file to Outline, idempotently, and (new here)
 * clean up a test/scratch collection when you're done with one.
 *
 * This is a TypeScript port of an earlier Python publish script, moved
 * into this repo so the whole render -> publish pipeline is one JS/TS tool
 * instead of two repos in two languages. The publish mechanics are
 * unchanged from that script - see its original module docstring
 * (preserved in spirit below) for why they're shaped this way.
 *
 * ---
 *
 * github(main) -> Outline is treated as a one-way publish: this module is
 * the only thing that should ever write to documents it manages. Re-running
 * it on the same file updates the same Outline document instead of
 * creating a new one every time, by round-tripping the Outline document ID
 * through a YAML frontmatter field this module owns:
 *
 *     ---
 *     outline_id: 3a1e1f2b-...
 *     ---
 *     # Your document
 *
 * On first publish there's no outline_id yet, so this creates the document
 * and rewrites the source file with the new ID added to its frontmatter. In
 * CI, that rewritten file needs to be committed back to the repo or every
 * run will look like a first-publish and create a duplicate.
 *
 * Deliberately does NOT support pulling changes back from Outline. Docs a
 * human edits live *in* Outline belong in a different collection from the
 * one this publishes into - this only ever pushes forward, and only ever
 * touches documents whose ID it put there itself. If a document's
 * outline_id points at something that no longer exists (deleted, moved to
 * a different collection by a human, etc.), it fails loudly rather than
 * guessing - see resolveExistingDocument.
 *
 * A frontmatter `icon:` field (a plain emoji character) is passed through
 * to Outline's `icon` field on documents.create/documents.update if
 * present - src/cli.ts's render commands stamp one in automatically based
 * on source format (confirmed against Outline's own zodIconType() schema,
 * which accepts a plain emoji, a named icon, or a custom emoji UUID; this
 * only ever sends the plain-emoji form).
 *
 * Env vars:
 *   OUTLINE_API_KEY   required
 *   OUTLINE_API_URL   default: https://app.getoutline.com/api
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { render as renderBpmn, extractProcessSummaries, ICON as BPMN_ICON } from "./renderers/bpmn.js";
import { render as renderDmn, extractDecisionSummaries, ICON as DMN_ICON } from "./renderers/dmn.js";
import { buildCrossRef, type CrossRefSource } from "./crossref.js";
import { loadManifest, saveManifest, diffManifest, hashContent, type ManifestEntry } from "./manifest.js";

const DEFAULT_API_URL = "https://app.getoutline.com/api";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

// Cloudflare's bot-fight-mode on this zone rejects default HTTP client user
// agents (undici's default UA got a Cloudflare 1010, not an Outline error,
// building the original Python version of this) - any normal-looking UA
// clears it.
const USER_AGENT = "outline-render/1.0";

export interface OutlineConfig {
  apiUrl: string;
  apiKey: string;
}

export class OutlineError extends Error {}

export function loadConfig(apiUrlOverride?: string): OutlineConfig {
  const apiKey = process.env.OUTLINE_API_KEY;
  if (!apiKey) {
    throw new OutlineError(
      "OUTLINE_API_KEY not set (env var, or a .env file in the working directory - see .env.example)"
    );
  }
  return {
    apiKey,
    apiUrl: apiUrlOverride || process.env.OUTLINE_API_URL || DEFAULT_API_URL,
  };
}

async function apiCall(config: OutlineConfig, endpoint: string, payload: unknown): Promise<any> {
  const res = await fetch(`${config.apiUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new OutlineError(`${endpoint} -> HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

/** Minimal flat-key frontmatter parser - good enough for `outline_id` and
 * `title` without pulling in a YAML dependency. */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { fm: {}, body: raw };
  const [, block, body] = m;
  const fm: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    fm[key] = value;
  }
  return { fm, body };
}

function renderFrontmatter(fm: Record<string, string>, body: string): string {
  if (Object.keys(fm).length === 0) return body;
  const lines = ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", ""];
  return lines.join("\n") + body;
}

function deriveTitle(fm: Record<string, string>, body: string, sourcePath: string): string {
  if (fm.title) return fm.title;
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(sourcePath, path.extname(sourcePath));
}

async function getOrCreateCollection(config: OutlineConfig, name: string): Promise<{ id: string; url: string }> {
  const resp = await apiCall(config, "collections.list", { limit: 100 });
  const existing = resp.data.find((c: any) => c.name === name);
  if (existing) return { id: existing.id, url: existing.url };
  const created = await apiCall(config, "collections.create", {
    name,
    description: "Managed by outline-render publish - do not edit here, changes are overwritten on next sync.",
  });
  return { id: created.data.id, url: created.data.url };
}

async function findCollectionByName(config: OutlineConfig, name: string): Promise<{ id: string } | null> {
  const resp = await apiCall(config, "collections.list", { limit: 100 });
  return resp.data.find((c: any) => c.name === name) ?? null;
}

async function resolveExistingDocument(config: OutlineConfig, docId: string): Promise<any | null> {
  try {
    const resp = await apiCall(config, "documents.info", { id: docId });
    return resp.data;
  } catch (e: any) {
    if (e instanceof OutlineError && e.message.includes("HTTP 404")) return null;
    throw e;
  }
}

async function findTopLevelDocumentByTitle(
  config: OutlineConfig,
  collectionId: string,
  title: string
): Promise<{ id: string } | null> {
  const resp = await apiCall(config, "collections.documents", { id: collectionId });
  const found = (resp.data ?? []).find((d: any) => d.title === title);
  return found ? { id: found.id } : null;
}

async function getOrCreateChangesParent(config: OutlineConfig, collectionId: string): Promise<{ id: string }> {
  const existing = await findTopLevelDocumentByTitle(config, collectionId, "Changes");
  if (existing) return existing;
  const resp = await apiCall(config, "documents.create", {
    collectionId,
    title: "Changes",
    text:
      "# Changes\n\nAutomated sync history for this repo - each entry below is a point-in-time " +
      "record of one publish-tree run with a manifest, created once and never edited afterward.\n",
    publish: true,
  });
  return { id: resp.data.id };
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

// --- Multi-file publish with cross-document link rewriting --------------
//
// A single publish() call has no idea other files in the same repo exist,
// so a relative markdown link like [ADRs](docs/adr/README.md) - perfectly
// valid on GitHub - gets pushed to Outline completely unchanged. Outline
// has no concept of "relative to this document" for links, so that link
// is just dead there. publishTree() fixes this for a batch of files
// published together: two passes, because resolving link B -> A requires
// A's Outline URL to already be known, but a naive single pass hits files
// in filesystem order, not link-dependency order (and could have cycles
// anyway - two files linking to each other - so a dependency-ordered
// single pass isn't even possible in general).
//
//   Phase 1: ensure every file has an Outline document (create if it has
//            no outline_id yet), recording repo-relative-path -> Outline
//            URL as we go. Content pushed here still has unrewritten
//            links - that's fixed in phase 2, not skipped.
//   Phase 2: now that every file's URL is known, rewrite each file's
//            internal links and push the corrected content.
//
// Links to something NOT in this batch (a .sh script, a non-md file, or
// an .md file that exists but wasn't part of this publish run) get
// rewritten to a GitHub blob URL instead of left as a dead relative path -
// still resolves to something real, just off in the source repo rather
// than in Outline.
//
// Deliberately does NOT try to preserve heading anchors (#some-heading)
// when rewriting to an Outline URL - Outline generates its own anchor
// slugs from its own document, which won't reliably match GitHub's slug
// for the same heading. Landing on the right document beats a wrong
// guess at the right anchor within it.
//
// A file can optionally be paired with the .bpmn/.dmn SOURCE it was
// rendered from (the `sources` map - repo-relative markdown path -> that
// source's absolute path). For those files, the .md file's only job is
// persisting outline_id/icon frontmatter across runs; its body is always
// freshly regenerated here from the source (via bpmn.ts's/dmn.ts's own
// render(), not read from disk) so it can be rendered a second time in
// phase 2 with cross-reference data resolved - see crossref.ts for how a
// BPMN businessRuleTask's called decision gets matched to the DMN that
// declares it (by decision id, never by filename/path), producing real
// links between them once both documents' Outline URLs are known.
//
// publishTree() also fixes a second, related problem: a flat batch of
// files publishes as flat siblings in the collection, discarding the
// repo's directory structure entirely (docs/adr/*.md and
// docs/infrastructure/*.md end up indistinguishable in Outline's sidebar).
// resolveIndexParent() nests a file under its own directory's README.md/
// index.md - *if* that index file is part of the same publish batch -
// using Outline's documents.move (a separate step from documents.create/
// update; parentDocumentId isn't settable after creation any other way).
// Deliberately does NOT synthesize a placeholder parent document for a
// directory that has no README/index of its own (docs/infrastructure/ in
// the real repo this was built against has no such file) - inventing
// content nobody wrote is a different, bigger decision than nesting
// under a doc that already exists, so those files stay flat rather than
// guessing at what a synthetic container document should contain.

const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INDEX_FILENAMES = ["README.md", "readme.md", "index.md"];

/** Returns the repo-relative path of the nearest ancestor directory's own
 * index file (README.md/index.md) that's part of `allRepoPaths` -
 * undefined if none of repoPath's ancestor directories (up to and
 * including the repo root) have one, or if repoPath *is* that index file
 * (an index doesn't nest under itself). Climbing to the nearest ancestor
 * rather than stopping at the immediate directory means a directory with
 * no index of its own (docs/infrastructure/ in the real repo this was
 * built against) still nests under the repo's root README rather than
 * staying a flat top-level sibling of it - only a directory that itself
 * has its own index (docs/adr/README.md) gets its own extra nesting
 * level below that. */
export function resolveIndexParent(repoPath: string, allRepoPaths: ReadonlySet<string>): string | undefined {
  let dir = path.posix.dirname(repoPath);
  while (true) {
    for (const filename of INDEX_FILENAMES) {
      const indexPath = dir === "." ? filename : `${dir}/${filename}`;
      if (indexPath !== repoPath && allRepoPaths.has(indexPath)) return indexPath;
    }
    if (dir === ".") return undefined;
    dir = path.posix.dirname(dir);
  }
}

/** True for the repo's own top-level README.md/index.md - the file
 * `rootAsCollectionDescription` maps into the collection's own `description`
 * (a real Outline field, confirmed markdown-rendered as the collection's
 * landing page) instead of creating a redundant document whose name just
 * repeats the collection's own. */
function isRootIndexFile(repoPath: string): boolean {
  return path.posix.dirname(repoPath) === "." && INDEX_FILENAMES.includes(path.posix.basename(repoPath));
}

function isSkippableLink(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#");
}

function toRepoPath(absPath: string, repoRoot: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function resolveRelativeRepoPath(fromRepoPath: string, target: string): string {
  const fromDir = path.posix.dirname(fromRepoPath);
  return path.posix.normalize(path.posix.join(fromDir, target));
}

export function rewriteLinks(
  body: string,
  fromRepoPath: string,
  pathToOutlineUrl: Map<string, string>,
  githubBlobBaseUrl?: string
): string {
  return body.replace(MD_LINK_RE, (full, text, target) => {
    if (isSkippableLink(target)) return full;
    const [targetPath, anchor] = target.split("#");
    if (!targetPath) return full; // pure "#anchor" within the same doc
    const resolved = resolveRelativeRepoPath(fromRepoPath, targetPath);
    const outlineUrl = pathToOutlineUrl.get(resolved);
    if (outlineUrl) {
      return `[${text}](${outlineUrl})`;
    }
    if (!githubBlobBaseUrl) return full; // nothing sensible to rewrite to - leave it
    const suffix = anchor ? `#${anchor}` : "";
    return `[${text}](${githubBlobBaseUrl}/${resolved}${suffix})`;
  });
}

interface TreeFileState {
  absPath: string;
  repoPath: string;
  fm: Record<string, string>;
  body: string;
  title: string;
  docId: string;
  /** Set only for a file paired with a .bpmn/.dmn source (via the
   * `sources` map) - lets phase 2 re-render with resolved cross-reference
   * data instead of just rewriting links in already-final body text.
   * `title`, if resolvable, is the first process's/decision's own name -
   * without it, every --source-rendered file would get the same generic
   * default title ("Process Catalogue"/"Decision Catalogue"), which is
   * fine for one file but useless for telling several apart in a batch. */
  source?: { absPath: string; kind: "bpmn" | "dmn"; title?: string };
  /** The body actually pushed to Outline in phase 2 (post link-rewriting
   * and, for source-derived files, post cross-ref resolution) - filled in
   * during phase 2, used afterward to compute this run's manifest entry. */
  finalBody?: string;
}

function sourceKind(sourceAbsPath: string): "bpmn" | "dmn" | undefined {
  const ext = path.extname(sourceAbsPath).toLowerCase();
  if (ext === ".bpmn") return "bpmn";
  if (ext === ".dmn") return "dmn";
  return undefined;
}

/** The first process's/decision's own name, if the source declares one -
 * used as this file's document title instead of render()'s generic
 * per-format default, which would otherwise be identical across every
 * --source-rendered file in a batch. */
async function deriveSourceTitle(kind: "bpmn" | "dmn", sourceAbsPath: string): Promise<string | undefined> {
  if (kind === "bpmn") {
    const summaries = await extractProcessSummaries(sourceAbsPath);
    return summaries[0]?.name;
  }
  const summaries = await extractDecisionSummaries(sourceAbsPath);
  return summaries[0]?.name;
}

/** Reads a file's existing frontmatter if it exists yet - {} for a file
 * that doesn't (e.g. a .bpmn/.dmn-paired .md file on its first run,
 * before this tool has ever written one). */
async function readExistingFrontmatter(absPath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(absPath, "utf-8");
    return parseFrontmatter(raw).fm;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

export interface PublishTreeOptions {
  githubBlobBaseUrl?: string;
  /** repo-relative-.md-abspath -> .bpmn/.dmn source abspath, from --source. */
  sources?: Map<string, string>;
  /** Path to a manifest file (see manifest.ts) tracking what's been
   * published across runs. Omitted entirely = no deletion tracking, no
   * changelog - today's behavior, unchanged. */
  manifestPath?: string;
  /** Actually archive documents whose repoPath disappeared from this
   * run's file list (per the manifest). Without this, removed entries are
   * only reported (console + changelog), never touched in Outline -
   * mirrors delete-collection's own --yes gate for a destructive action
   * this tool takes unattended in CI. */
  prune?: boolean;
  /** Commit SHA to note in the changelog entry's title/body, if given. */
  commit?: string;
  /** Maps the repo's own top-level README.md/index.md into the
   * collection's `description` (its landing page) instead of creating a
   * document for it whose title just repeats the collection's own name.
   * Off by default: turning it on for a collection that already has a
   * real document there needs a one-time migration (archiving that old
   * document), which is worth being an explicit opt-in rather than
   * something that happens silently the first time this runs. */
  rootAsCollectionDescription?: boolean;
}

export async function publishTree(
  files: string[],
  repoRoot: string,
  collectionName: string,
  config: OutlineConfig,
  options: PublishTreeOptions = {}
): Promise<void> {
  const {
    githubBlobBaseUrl,
    sources = new Map(),
    manifestPath,
    prune = false,
    commit,
    rootAsCollectionDescription = false,
  } = options;
  const instanceUrl = config.apiUrl.replace(/\/api\/?$/, "");
  const { id: collectionId, url: collectionUrl } = await getOrCreateCollection(config, collectionName);
  const pathToUrl = new Map<string, string>();
  const states: TreeFileState[] = [];
  let rootIndexRepoPath: string | undefined;
  // Captured in phase 1, actually pushed to Outline in phase 2 (see there
  // for why: its own outgoing links need rewriteLinks same as any other
  // file's, which needs every other file's URL to be known first).
  let rootFileState: { fm: Record<string, string>; body: string } | undefined;

  // Phase 1
  for (const absPath of files) {
    const sourceAbsPath = sources.get(absPath);
    const kind = sourceAbsPath ? sourceKind(sourceAbsPath) : undefined;
    if (sourceAbsPath && !kind) {
      console.error(`warning: ${sourceAbsPath} is not a .bpmn or .dmn file - ignoring --source pairing for ${absPath}`);
    }

    let fm: Record<string, string>;
    let body: string;
    let sourceTitle: string | undefined;
    if (kind) {
      // The .md file (if it exists yet from a previous run) only persists
      // outline_id/icon across runs here - its body is always freshly
      // regenerated from the paired source below, never read from disk.
      fm = await readExistingFrontmatter(absPath);
      if (!fm.icon) fm.icon = kind === "bpmn" ? BPMN_ICON : DMN_ICON;
      sourceTitle = await deriveSourceTitle(kind, sourceAbsPath!);
      const titleOption = sourceTitle ? { title: sourceTitle } : {};
      body = kind === "bpmn" ? await renderBpmn(sourceAbsPath!, titleOption) : await renderDmn(sourceAbsPath!, titleOption);
    } else {
      const raw = await readFile(absPath, "utf-8");
      ({ fm, body } = parseFrontmatter(raw));
    }

    const repoPath = toRepoPath(absPath, repoRoot);

    if (rootAsCollectionDescription && isRootIndexFile(repoPath)) {
      // A document already existed here from before this option was
      // turned on - migrate away from it rather than leave an orphan.
      // Doesn't depend on link-rewriting, so no need to wait for phase 2.
      if (fm.outline_id) {
        const existing = await resolveExistingDocument(config, fm.outline_id);
        if (existing) {
          await apiCall(config, "documents.delete", { id: fm.outline_id });
          console.log(`Migrated: ${repoPath} -> collection description (archived old document ${fm.outline_id})`);
        }
      }
      // No document backs this content any more, so there's no id left to
      // persist - drop any frontmatter this file was carrying.
      if (Object.keys(fm).length > 0) {
        await writeFile(absPath, body);
      }

      rootIndexRepoPath = repoPath;
      rootFileState = { fm, body };
      // The collection's own URL is already known (getOrCreateCollection
      // resolved it above), so other files can link to it even though the
      // actual collections.update call - which needs this file's *own*
      // links rewritten first - doesn't happen until phase 2.
      pathToUrl.set(repoPath, `${instanceUrl}${collectionUrl}`);
      continue;
    }

    const title = deriveTitle(fm, body, absPath);

    let docId = fm.outline_id;
    let url: string;
    if (docId) {
      const existing = await resolveExistingDocument(config, docId);
      if (!existing) {
        throw new OutlineError(
          `${absPath} has outline_id=${docId} but that document no longer exists in Outline. ` +
            "Not guessing - remove the outline_id frontmatter field manually if this should publish as new."
        );
      }
      url = existing.url;
    } else {
      const resp = await apiCall(config, "documents.create", {
        collectionId,
        title,
        text: body,
        publish: true,
        ...(fm.icon ? { icon: fm.icon } : {}),
      });
      docId = resp.data.id;
      url = resp.data.url;
      fm.outline_id = docId;
      // Source-derived files write their frontmatter+body together at the
      // end of phase 2 instead, once the final cross-ref-resolved body is
      // known - writing the interim (unresolved) body here would just get
      // overwritten anyway.
      if (!kind) {
        await writeFile(absPath, renderFrontmatter(fm, body));
      }
      console.log(`Created: ${repoPath} -> ${url}`);
    }
    pathToUrl.set(repoPath, `${instanceUrl}${url}`);
    states.push({
      absPath,
      repoPath,
      fm,
      body,
      title,
      docId,
      source: kind ? { absPath: sourceAbsPath!, kind, title: sourceTitle } : undefined,
    });
  }

  // The collection description itself is pushed here, not in phase 1 -
  // its own outgoing links need rewriteLinks the same as any other file's,
  // which needs every other file's URL to be known first (exactly the
  // reason phase 2 exists at all for regular files).
  if (rootFileState && rootIndexRepoPath) {
    const rewrittenDescription = rewriteLinks(rootFileState.body, rootIndexRepoPath, pathToUrl, githubBlobBaseUrl);
    await apiCall(config, "collections.update", {
      id: collectionId,
      description: rewrittenDescription,
      ...(rootFileState.fm.icon ? { icon: rootFileState.fm.icon } : {}),
    });
    console.log(`Collection description: ${rootIndexRepoPath} -> ${instanceUrl}${collectionUrl}`);
  }

  // Phase 1.5: resolve bpmn<->dmn cross-references, now that every file's
  // Outline URL is known.
  const crossRefSources: CrossRefSource[] = states
    .filter((s) => s.source)
    .map((s) => ({ mdAbsPath: s.absPath, sourceAbsPath: s.source!.absPath }));
  const { bpmnResolvers, dmnUsedBy } =
    crossRefSources.length > 0
      ? await buildCrossRef(crossRefSources, (mdAbsPath) => {
          const state = states.find((s) => s.absPath === mdAbsPath)!;
          return pathToUrl.get(state.repoPath)!;
        })
      : { bpmnResolvers: new Map(), dmnUsedBy: new Map() };

  // Phase 2
  const allRepoPaths = new Set(states.map((s) => s.repoPath));
  if (rootIndexRepoPath) allRepoPaths.add(rootIndexRepoPath);
  const repoPathToDocId = new Map(states.map((s) => [s.repoPath, s.docId]));

  for (const state of states) {
    const parentRepoPath = resolveIndexParent(state.repoPath, allRepoPaths);
    // When the resolved "parent" is the file mapped to the collection's own
    // description, there's no document to move under - it's not in
    // repoPathToDocId at all, and top-level-in-the-collection (skipping the
    // move) is exactly the right place for it anyway.
    if (parentRepoPath && parentRepoPath !== rootIndexRepoPath) {
      await apiCall(config, "documents.move", {
        id: state.docId,
        parentDocumentId: repoPathToDocId.get(parentRepoPath),
      });
    }

    let finalBody: string;
    if (state.source) {
      const titleOption = state.source.title ? { title: state.source.title } : {};
      finalBody =
        state.source.kind === "bpmn"
          ? await renderBpmn(state.source.absPath, titleOption, { resolveDecision: bpmnResolvers.get(state.absPath) })
          : await renderDmn(state.source.absPath, titleOption, { usedBy: dmnUsedBy.get(state.absPath) });
      finalBody = rewriteLinks(finalBody, state.repoPath, pathToUrl, githubBlobBaseUrl);
      await writeFile(state.absPath, renderFrontmatter(state.fm, finalBody));
    } else {
      finalBody = rewriteLinks(state.body, state.repoPath, pathToUrl, githubBlobBaseUrl);
    }

    await apiCall(config, "documents.update", {
      id: state.docId,
      title: state.title,
      text: finalBody,
      ...(state.fm.icon ? { icon: state.fm.icon } : {}),
    });
    state.finalBody = finalBody;
    const nestingNote =
      rootIndexRepoPath !== undefined && parentRepoPath === rootIndexRepoPath
        ? " (top-level - root mapped to collection description)"
        : parentRepoPath
          ? ` (nested under ${parentRepoPath})`
          : "";
    console.log(`Synced: ${state.repoPath} -> ${pathToUrl.get(state.repoPath)}${nestingNote}`);
  }

  // Phase 3: manifest-based deletion tracking + changelog. Only runs when
  // a manifest path is given - omitting it is exactly today's behavior
  // (no deletion tracking, no changelog), so existing callers are
  // unaffected. Runs *after* phase 2's nesting pass above completes: any
  // survivor previously nested under a since-removed index has already
  // been re-parented to its next valid ancestor by then (resolveIndexParent
  // only ever sees this run's current repoPaths), so archiving a removed
  // parent here can't orphan children that are still being published -
  // confirmed against Outline's own Document model, which has no
  // destroy-cascades-to-children hook (only Collection does, for deleting
  // a whole collection), so getting this ordering right matters.
  if (manifestPath) {
    const previous = await loadManifest(manifestPath);
    const currentEntries: Record<string, ManifestEntry> = {};
    for (const state of states) {
      currentEntries[state.repoPath] = {
        outlineId: state.docId,
        title: state.title,
        contentHash: hashContent(state.finalBody ?? state.body),
      };
    }

    const diff = diffManifest(previous, currentEntries);

    for (const repoPath of diff.removed) {
      const entry = previous.entries[repoPath];
      if (prune) {
        await apiCall(config, "documents.delete", { id: entry.outlineId });
        console.log(`Archived: ${repoPath} (was "${entry.title}")`);
      } else {
        console.error(
          `warning: ${repoPath} (was "${entry.title}") looks removed from the repo but was NOT archived - re-run with --prune to archive it in Outline.`
        );
      }
    }

    const newManifest = {
      version: 1 as const,
      entries: prune
        ? currentEntries
        : {
            ...currentEntries,
            ...Object.fromEntries(diff.removed.map((repoPath) => [repoPath, previous.entries[repoPath]])),
          },
    };
    await saveManifest(manifestPath, newManifest);

    if (diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0) {
      const changesParent = await getOrCreateChangesParent(config, collectionId);
      const timestamp = formatTimestamp(new Date());
      const changelogTitle = commit ? `${timestamp}_${commit}` : timestamp;

      const lines = [`# Sync ${new Date().toISOString()}${commit ? ` (${commit})` : ""}`, ""];
      const section = (label: string, repoPaths: string[]) => {
        if (repoPaths.length === 0) return;
        lines.push(`## ${label}`, "");
        for (const repoPath of repoPaths) {
          const entry = currentEntries[repoPath];
          const url = pathToUrl.get(repoPath);
          lines.push(url ? `- [${entry.title}](${url})` : `- ${entry.title}`);
        }
        lines.push("");
      };
      section("Added", diff.added);
      section("Changed", diff.changed);
      if (diff.removed.length > 0) {
        lines.push(`## Removed${prune ? " (archived)" : " (not yet archived - re-run with --prune)"}`, "");
        for (const repoPath of diff.removed) {
          lines.push(`- ${previous.entries[repoPath].title}`);
        }
        lines.push("");
      }

      const resp = await apiCall(config, "documents.create", {
        collectionId,
        parentDocumentId: changesParent.id,
        title: changelogTitle,
        text: lines.join("\n"),
        publish: true,
      });
      console.log(`Changelog: ${changelogTitle} -> ${instanceUrl}${resp.data.url}`);
    }
  }
}

export async function publish(sourcePath: string, collectionName: string, config: OutlineConfig): Promise<void> {
  const raw = await readFile(sourcePath, "utf-8");
  const { fm, body } = parseFrontmatter(raw);
  const title = deriveTitle(fm, body, sourcePath);
  const { id: collectionId } = await getOrCreateCollection(config, collectionName);

  const existingId = fm.outline_id;
  if (existingId) {
    const existing = await resolveExistingDocument(config, existingId);
    if (!existing) {
      throw new OutlineError(
        `${sourcePath} has outline_id=${existingId} but that document no longer exists in Outline ` +
          "(deleted, or moved outside this tool's reach). Not guessing - remove the outline_id " +
          "frontmatter field manually if you want this to publish as a new document."
      );
    }
    await apiCall(config, "documents.update", {
      id: existingId,
      title,
      text: body,
      ...(fm.icon ? { icon: fm.icon } : {}),
    });
    console.log(`Updated: ${existing.url}`);
    return;
  }

  const resp = await apiCall(config, "documents.create", {
    collectionId,
    title,
    text: body,
    publish: true,
    ...(fm.icon ? { icon: fm.icon } : {}),
  });
  const newId = resp.data.id;
  fm.outline_id = newId;
  await writeFile(sourcePath, renderFrontmatter(fm, body));
  console.log(`Created: ${resp.data.url}`);
  console.log(`Wrote outline_id back into ${sourcePath} - commit this change so the next run updates instead of duplicating.`);
}

/**
 * Deletes a collection by name (and, per Outline's server-side cascade,
 * every document in it). This is a destructive, effectively irreversible
 * operation from the API's perspective - Outline soft-deletes the row
 * (sets deletedAt) rather than hard-deleting it server-side, but exposes
 * no restore-from-trash endpoint for collections the way it does for
 * archived collections, so treat it as permanent. Intended for tearing
 * down throwaway test collections, not anything with real content -
 * callers MUST get explicit confirmation before calling this (the CLI's
 * `delete-collection` command requires --yes).
 */
export async function deleteCollection(collectionName: string, config: OutlineConfig): Promise<void> {
  const collection = await findCollectionByName(config, collectionName);
  if (!collection) {
    throw new OutlineError(`No collection named ${JSON.stringify(collectionName)} found.`);
  }
  await apiCall(config, "collections.delete", { id: collection.id });
  console.log(`Deleted collection ${JSON.stringify(collectionName)} (and its documents).`);
}
