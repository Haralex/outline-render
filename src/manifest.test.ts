import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { emptyManifest, loadManifest, saveManifest, hashContent, diffManifest, type Manifest } from "./manifest.js";

test("loadManifest: a missing file returns an empty manifest, not an error", async () => {
  const manifest = await loadManifest("/nonexistent/path/manifest.json");
  assert.deepEqual(manifest, emptyManifest());
});

test("saveManifest + loadManifest round-trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "outline-render-manifest-"));
  const file = path.join(dir, "manifest.json");
  const manifest: Manifest = {
    version: 1,
    entries: { "docs/adr/001.md": { outlineId: "abc", title: "ADR-001", contentHash: "deadbeef" } },
  };
  try {
    await saveManifest(file, manifest);
    const loaded = await loadManifest(file);
    assert.deepEqual(loaded, manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hashContent: identical content hashes identically, different content doesn't", () => {
  assert.equal(hashContent("hello"), hashContent("hello"));
  assert.notEqual(hashContent("hello"), hashContent("world"));
});

test("diffManifest: a repoPath with no previous entry is added", () => {
  const diff = diffManifest(emptyManifest(), {
    "a.md": { outlineId: "1", title: "A", contentHash: "h1" },
  });
  assert.deepEqual(diff, { added: ["a.md"], changed: [], unchanged: [], removed: [] });
});

test("diffManifest: a repoPath with the same content hash as before is unchanged", () => {
  const previous: Manifest = { version: 1, entries: { "a.md": { outlineId: "1", title: "A", contentHash: "h1" } } };
  const diff = diffManifest(previous, { "a.md": { outlineId: "1", title: "A", contentHash: "h1" } });
  assert.deepEqual(diff, { added: [], changed: [], unchanged: ["a.md"], removed: [] });
});

test("diffManifest: a repoPath with a different content hash than before is changed", () => {
  const previous: Manifest = { version: 1, entries: { "a.md": { outlineId: "1", title: "A", contentHash: "h1" } } };
  const diff = diffManifest(previous, { "a.md": { outlineId: "1", title: "A", contentHash: "h2" } });
  assert.deepEqual(diff, { added: [], changed: ["a.md"], unchanged: [], removed: [] });
});

test("diffManifest: a repoPath in the previous manifest but not this run's set is removed", () => {
  const previous: Manifest = { version: 1, entries: { "a.md": { outlineId: "1", title: "A", contentHash: "h1" } } };
  const diff = diffManifest(previous, {});
  assert.deepEqual(diff, { added: [], changed: [], unchanged: [], removed: ["a.md"] });
});

test("diffManifest: a realistic mixed batch categorizes each repoPath correctly", () => {
  const previous: Manifest = {
    version: 1,
    entries: {
      "kept-same.md": { outlineId: "1", title: "Kept Same", contentHash: "h1" },
      "kept-changed.md": { outlineId: "2", title: "Kept Changed", contentHash: "h2-old" },
      "gone.md": { outlineId: "3", title: "Gone", contentHash: "h3" },
    },
  };
  const current = {
    "kept-same.md": { outlineId: "1", title: "Kept Same", contentHash: "h1" },
    "kept-changed.md": { outlineId: "2", title: "Kept Changed", contentHash: "h2-new" },
    "brand-new.md": { outlineId: "4", title: "Brand New", contentHash: "h4" },
  };
  const diff = diffManifest(previous, current);
  assert.deepEqual(diff.added, ["brand-new.md"]);
  assert.deepEqual(diff.changed, ["kept-changed.md"]);
  assert.deepEqual(diff.unchanged, ["kept-same.md"]);
  assert.deepEqual(diff.removed, ["gone.md"]);
});
