import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteLinks, resolveIndexParent } from "./outline.js";

test("rewriteLinks: bare repo-relative link resolves to the target's Outline URL", () => {
  // The exact shape that was breaking in production: a bare relative path
  // with no leading "./", e.g. [text](docs/infrastructure/overview.md) -
  // valid on GitHub, but Outline has no concept of "relative to this
  // document" and was importing it as a dead link (observed live: it got
  // auto-prefixed to "https://docs/adr/README.md", going nowhere).
  const pathToUrl = new Map([["docs/infrastructure/overview.md", "https://wiki.example.com/doc/overview-abc123"]]);
  const out = rewriteLinks(
    "See [docs/infrastructure/overview.md](docs/infrastructure/overview.md) for details.",
    "README.md",
    pathToUrl
  );
  assert.equal(out, "See [docs/infrastructure/overview.md](https://wiki.example.com/doc/overview-abc123) for details.");
});

test("rewriteLinks: resolves relative to the *linking* document's own directory, not the repo root", () => {
  const pathToUrl = new Map([
    ["docs/adr/001-knowledge-base-notion-vs-obsidian.md", "https://wiki.example.com/doc/adr-001"],
  ]);
  const out = rewriteLinks(
    "See [ADR-001](001-knowledge-base-notion-vs-obsidian.md).",
    "docs/adr/README.md",
    pathToUrl
  );
  assert.equal(out, "See [ADR-001](https://wiki.example.com/doc/adr-001).");
});

test("rewriteLinks: drops the anchor when rewriting to an Outline URL", () => {
  // Outline generates its own anchor slugs - a GitHub heading slug won't
  // reliably match, so landing on the right document beats guessing at
  // the right anchor within it.
  const pathToUrl = new Map([["docs/adr/002-kubernetes-strategy.md", "https://wiki.example.com/doc/adr-002"]]);
  const out = rewriteLinks("[ADR-002](docs/adr/002-kubernetes-strategy.md#decision)", "README.md", pathToUrl);
  assert.equal(out, "[ADR-002](https://wiki.example.com/doc/adr-002)");
});

test("rewriteLinks: leaves a pure same-document anchor link untouched", () => {
  const out = rewriteLinks("[Open Questions](#open-questions)", "docs/infrastructure/overview.md", new Map());
  assert.equal(out, "[Open Questions](#open-questions)");
});

test("rewriteLinks: leaves external links (http/https/mailto) untouched", () => {
  const body =
    "[Outline](https://www.getoutline.com/) and [Cube.dev](http://cube.dev) and [me](mailto:a@b.com)";
  assert.equal(rewriteLinks(body, "README.md", new Map()), body);
});

test("rewriteLinks: a link to a file outside the batch is left as-is when no GitHub base is given", () => {
  const out = rewriteLinks("[workflow](.github/workflows/build-n8n.yml)", "README.md", new Map());
  assert.equal(out, "[workflow](.github/workflows/build-n8n.yml)");
});

test("rewriteLinks: a link to a file outside the batch rewrites to a GitHub blob URL when a base is given", () => {
  const out = rewriteLinks(
    "[workflow](.github/workflows/build-n8n.yml)",
    "README.md",
    new Map(),
    "https://github.com/example/my-repo/blob/main"
  );
  assert.equal(
    out,
    "[workflow](https://github.com/example/my-repo/blob/main/.github/workflows/build-n8n.yml)"
  );
});

test("rewriteLinks: GitHub blob URL fallback preserves the anchor (unlike the Outline-URL case)", () => {
  const out = rewriteLinks(
    "[see](k8s/postgres/README.md#not-deployed)",
    "README.md",
    new Map(),
    "https://github.com/example/my-repo/blob/main"
  );
  assert.equal(out, "[see](https://github.com/example/my-repo/blob/main/k8s/postgres/README.md#not-deployed)");
});

test("rewriteLinks: link text is preserved exactly regardless of rewrite", () => {
  const pathToUrl = new Map([["docs/adr/README.md", "https://wiki.example.com/doc/adr-index"]]);
  const out = rewriteLinks("[docs/adr/](docs/adr/README.md)", "README.md", pathToUrl);
  assert.equal(out, "[docs/adr/](https://wiki.example.com/doc/adr-index)");
});

test("rewriteLinks: a link to a directory (trailing slash, no filename) outside the batch falls back to a GitHub blob URL", () => {
  // Real pattern: [`k8s/portainer/`](../../k8s/portainer/) - a directory
  // listing link, not a specific file.
  const out = rewriteLinks(
    "[`k8s/portainer/`](../../k8s/portainer/)",
    "docs/infrastructure/services.md",
    new Map(),
    "https://github.com/example/my-repo/blob/main"
  );
  assert.equal(out, "[`k8s/portainer/`](https://github.com/example/my-repo/blob/main/k8s/portainer/)");
});

test("rewriteLinks: an anchored link that still resolves to a file inside the batch", () => {
  // Real pattern: [overview.md "Open Questions"](../infrastructure/overview.md#open-questions-decisions-needed)
  const pathToUrl = new Map([["docs/infrastructure/overview.md", "https://wiki.example.com/doc/overview"]]);
  const out = rewriteLinks(
    '[overview.md "Open Questions"](../infrastructure/overview.md#open-questions-decisions-needed)',
    "docs/openclaw/setup.md",
    pathToUrl
  );
  assert.equal(out, '[overview.md "Open Questions"](https://wiki.example.com/doc/overview)');
});

test("resolveIndexParent: a file in a directory with its own README.md nests under it", () => {
  const all = new Set([
    "docs/adr/README.md",
    "docs/adr/001-knowledge-base-notion-vs-obsidian.md",
    "docs/adr/002-kubernetes-strategy.md",
  ]);
  assert.equal(
    resolveIndexParent("docs/adr/001-knowledge-base-notion-vs-obsidian.md", all),
    "docs/adr/README.md"
  );
  assert.equal(resolveIndexParent("docs/adr/002-kubernetes-strategy.md", all), "docs/adr/README.md");
});

test("resolveIndexParent: an index file does not nest under itself", () => {
  const all = new Set(["docs/adr/README.md", "docs/adr/001-knowledge-base-notion-vs-obsidian.md"]);
  assert.equal(resolveIndexParent("docs/adr/README.md", all), undefined);
});

test("resolveIndexParent: a directory with no index of its own climbs to the nearest ancestor's index", () => {
  // The real case this was built against: docs/infrastructure/ has no
  // README.md, but the repo root does - files there should nest under
  // the root README rather than staying flat top-level siblings of it.
  const all = new Set([
    "README.md",
    "docs/infrastructure/overview.md",
    "docs/infrastructure/services.md",
  ]);
  assert.equal(resolveIndexParent("docs/infrastructure/overview.md", all), "README.md");
  assert.equal(resolveIndexParent("docs/infrastructure/services.md", all), "README.md");
});

test("resolveIndexParent: a subdirectory's own index still nests under a higher ancestor's index", () => {
  const all = new Set(["README.md", "docs/adr/README.md", "docs/adr/001-foo.md"]);
  // docs/adr/README.md has no index in "docs/adr/" itself (other than
  // itself) or in "docs/", so it climbs all the way to the repo root.
  assert.equal(resolveIndexParent("docs/adr/README.md", all), "README.md");
  // Its own children nest under the *nearer* docs/adr/README.md, not the
  // root - the nearest ancestor index wins.
  assert.equal(resolveIndexParent("docs/adr/001-foo.md", all), "docs/adr/README.md");
});

test("resolveIndexParent: a root-level file nests under the root README", () => {
  const all = new Set(["README.md", "BACKLOG.md"]);
  assert.equal(resolveIndexParent("BACKLOG.md", all), "README.md");
});

test("resolveIndexParent: no index anywhere in the batch leaves the file unparented", () => {
  const all = new Set(["docs/infrastructure/overview.md", "docs/openclaw/setup.md"]);
  assert.equal(resolveIndexParent("docs/infrastructure/overview.md", all), undefined);
});

test("resolveIndexParent: the root README itself is never parented", () => {
  const all = new Set(["README.md", "BACKLOG.md"]);
  assert.equal(resolveIndexParent("README.md", all), undefined);
});
