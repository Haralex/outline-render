/**
 * Tracks what publish-tree has published across runs, so it can tell what
 * got added, changed, or removed from the repo since last time - answering
 * "should this be archived in Outline?" and "what changed?" without
 * needing to read every file's frontmatter back out or diff git history.
 *
 * Deliberately a separate file (committed to the client repo, versioned
 * like everything else there) rather than folding this into a rebuild:
 * dropping and recreating every document each run would also work, but it
 * throws away outline_id/URL stability (every doc gets a new id and every
 * external link to it breaks, not just when something's actually removed),
 * destroys comments and view history on every single run rather than only
 * when something's genuinely deleted, and costs an API call per document
 * regardless of whether anything changed. A manifest answers the same
 * question (what's actually different this run) without any of that.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface ManifestEntry {
  outlineId: string;
  title: string;
  contentHash: string;
}

export interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { version: 1, entries: {} };
}

export async function loadManifest(manifestPath: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyManifest();
    throw err;
  }
}

export async function saveManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ManifestDiff {
  /** repoPaths with no entry in the previous manifest at all. */
  added: string[];
  /** repoPaths present before and now, but with a different content hash. */
  changed: string[];
  /** repoPaths present before and now, with the same content hash. */
  unchanged: string[];
  /** repoPaths in the previous manifest but not in this run's file set. */
  removed: string[];
}

/**
 * Compares the previous run's manifest against this run's current entries
 * (built from what was actually just published). Doesn't touch Outline or
 * the filesystem - purely a diff over two in-memory maps, so the "should
 * this be archived / does the changelog need an entry" decision is made
 * from data, not re-derived by re-reading anything.
 */
export function diffManifest(previous: Manifest, current: Record<string, ManifestEntry>): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [repoPath, entry] of Object.entries(current)) {
    const prev = previous.entries[repoPath];
    if (!prev) added.push(repoPath);
    else if (prev.contentHash !== entry.contentHash) changed.push(repoPath);
    else unchanged.push(repoPath);
  }

  const removed = Object.keys(previous.entries).filter((repoPath) => !(repoPath in current));

  return { added, changed, unchanged, removed };
}
