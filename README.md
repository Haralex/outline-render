# outline-render

Renders structured spec/schema files — OpenAPI specs, Prisma schemas, BPMN
processes, DMN decision tables, Cube.dev models — into markdown, and
(optionally) publishes that markdown to Outline.

The two concerns stay separated in code: every renderer
(`src/renderers/*.ts`) only ever turns a source file into a markdown
string and knows nothing about Outline or the network. `publish`/
`delete-collection` are the one place that talks to Outline's API
(`src/outline.ts`), invoked as an explicit separate step - so a client
repo that only wants markdown (to commit into its own docs, feed into a
static site, whatever) can use the render commands alone and never touch
the Outline half at all. See "Using this from a client repo" below for how
another repo wires the two together for its own pipeline.

TypeScript/Node, so it drops straight into a CI/CD step without needing a
Python interpreter in the loop - as a GitHub Action, an `npx`-invoked CLI,
or an npm dependency.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
node dist/cli.js openapi path/to/spec.yaml > api-docs.md
node dist/cli.js openapi path/to/spec.json --title "Custom Title"
node dist/cli.js prisma path/to/schema.prisma --title "Data Catalogue"
node dist/cli.js prisma path/to/schema.prisma --toc no
node dist/cli.js bpmn path/to/process.bpmn --title "Process Catalogue"
node dist/cli.js dmn path/to/decision.dmn --title "Decision Catalogue"
node dist/cli.js cube path/to/model.js --title "Cube Catalogue"
```

Or via `npx` once published:

```bash
npx outline-render openapi path/to/spec.yaml > api-docs.md
```

A "Contents" section linking to each H2-level heading (tags for `openapi`,
models/enums for `prisma`, processes for `bpmn`, decisions for `dmn`,
cubes for `cube`) is prepended by default - handy once a spec or schema
grows past a screenful. Pass `--toc no` to omit it.

Type columns get an icon per type, looked up by name (🔤 string, 🔢
number/int/float/decimal, ✅ boolean, 📅 date/time, 🧾 JSON, 🔗 a
relation/reference to another model or an unresolved nested schema, 📋 an
array, ❓ anything unrecognized) - see `scalarIcon` in
`src/renderers/base.ts`. Applies to `openapi` (schema properties and
parameters) and `prisma` (field types, with model/enum references getting
the relation icon rather than a scalar guess) and `cube` (dimension types).
Deliberately not applied to `bpmn`'s Type column (a Zeebe task-type
identifier, not a data type) or `dmn` (no fixed Type column to attach one
to).

## Publishing to Outline

```bash
cp .env.example .env   # fill in OUTLINE_API_KEY - .env is gitignored

node dist/cli.js openapi path/to/spec.yaml > api-docs.md
node dist/cli.js publish api-docs.md --collection "Docs Sync"
```

Idempotent by design: the first publish creates the Outline document and
writes its ID back into `api-docs.md`'s frontmatter as `outline_id`; every
later publish of that same file updates that document instead of creating
a duplicate. This is a one-way push, not a sync - it only ever writes to
documents whose `outline_id` it put there itself, and never reads Outline's
content back. Docs a human wants to edit live in Outline belong in a
different collection that no publish step ever touches; a collection this
publishes into should be treated as generated output, not hand-edited.

`--collection` names a collection, creating it if it doesn't already exist.
Set `OUTLINE_COLLECTION` in `.env` to skip passing `--collection` on every
call (`--collection` still overrides it when given). `delete-collection
[name] --yes` (name falls back to `OUTLINE_COLLECTION` too) deletes a
collection and every document in it - meant for tearing down throwaway test
collections, not anything with real content. It requires `--yes` and there
is no self-service undo: Outline exposes a restore path for *archived*
collections, but not for deleted ones, so treat this as permanent.

`OUTLINE_API_URL` defaults to `https://app.getoutline.com/api` (the
hosted cloud instance); override it (env var or `--api-url`) to point at
your own self-hosted instance.

### Publishing a whole doc tree: `publish-tree`

`publish` handles one file with no idea any other files exist. A batch of
markdown files that link to *each other* (a repo's own docs, cross-linking
its own README/ADRs/etc.) needs more: a bare relative link like
`[ADRs](docs/adr/README.md)` - perfectly valid on GitHub - means nothing to
Outline, which has no concept of "relative to this document"; left alone,
it gets imported as a dead link. And publishing each file independently
loses the repo's directory structure entirely - `docs/adr/*.md` and
`docs/infrastructure/*.md` end up as indistinguishable flat siblings in
Outline's sidebar.

```bash
node dist/cli.js publish-tree README.md BACKLOG.md docs/**/*.md \
  --collection "Docs Sync" \
  --repo-root . \
  --github-base "https://github.com/<org>/<repo>/blob/main"
```

`publish-tree` fixes both problems for a batch of files published together:

- **Cross-document links get rewritten** to the target's real Outline URL
  once it's known (a link to something outside the batch falls back to a
  GitHub blob URL if `--github-base` is given, otherwise it's left as-is -
  never worse than before). Heading anchors (`#some-heading`) are dropped
  when rewriting to an Outline URL, since Outline generates its own anchor
  slugs that won't reliably match GitHub's for the same heading - landing
  on the right document beats a wrong guess at the right anchor within it.
- **Directory structure is preserved as document nesting**: a file nests
  under its nearest ancestor directory's own `README.md`/`index.md`, if
  one is part of the same publish batch (climbing up - so a directory with
  no index of its own still nests under the repo's root README rather than
  staying a flat top-level sibling of it). A directory that itself has its
  own index file gets its own extra nesting level below that. Nothing is
  invented: a directory with no index anywhere above it in its ancestry
  just isn't nested - this doesn't synthesize placeholder "container"
  documents for directories nobody wrote an index for.

`--repo-root` (default: cwd) is what file paths are resolved relative to,
for both the link rewriting and the nesting. Same idempotency as `publish`
(`outline_id` round-tripped per file); same "commit the rewritten files
back in CI" caveat.

`publish-tree` doesn't take `--title` - unlike `publish`, which is happy to
publish an arbitrary single markdown file whatever its provenance,
`publish-tree` is specifically for a repo's own doc tree, where every
file's own `# Heading` (or `title:` frontmatter) is the right title.

#### Cross-referencing BPMN and DMN

A BPMN process can call a DMN decision (`<zeebe:calledDecision
decisionId="..." />` on a `businessRuleTask`) - by the decision's own `id`,
never by filename or path (confirmed against zeebe-bpmn-moddle's own type
descriptor, not guessed; it's the same id Zeebe itself resolves the call
with at runtime). Pair a rendered `.md` file with the `.bpmn`/`.dmn` source
it came from via `--source`, repeatable for as many pairs as the batch has:

```bash
node dist/cli.js publish-tree process.md decision.md \
  --collection "Docs Sync" \
  --repo-root . \
  --source process.md=process.bpmn \
  --source decision.md=decision.dmn
```

Once every file's Outline URL is known (same point in the pipeline the
link-rewriting and nesting above happen), the process's page gets a real
link to the decision it calls, and the decision's page gets a "Used by"
line linking back to the process(es) that call it - `src/crossref.ts` is
the id-matching logic, tested standalone; `src/renderers/bpmn.ts` and
`dmn.ts` both accept the resolved cross-reference data as an optional
third argument to `render()`, used only by `publish-tree`.

For a `--source`-paired file, the `.md` file's only job is persisting
`outline_id`/`icon` frontmatter across runs (exactly as for any other
file) - its *content* is always freshly regenerated from the paired
`.bpmn`/`.dmn` source on every run, not read from the `.md` file's own
text, so cross-references stay correct as the source changes. This is why
`--source` needs both paths: the source file is what actually gets
rendered; the `.md` file is just where the persistent Outline document id
lives between runs. Each file's own title, if it declares one (a process's
or decision's name), carries through automatically too - without that, a
batch of several `--source`-rendered files would all get the same generic
default title ("Process Catalogue"/"Decision Catalogue"), indistinguishable
from each other.

`examples/crossref/` has a small, real, four-file demo of this: two
processes (`content-approval.bpmn`, `editorial-review.bpmn`) and two
decisions (`content-tone.dmn`, `approval-priority.dmn`) - deliberately set
up so `content-tone.dmn` is called by *both* processes (its "Used by" line
lists two entries) while `approval-priority.dmn` is called by only one
(its "Used by" line lists just that one), showing both shapes:

```bash
node dist/cli.js publish-tree out/content-approval.md out/editorial-review.md out/content-tone.md out/approval-priority.md \
  --collection "Docs Sync" \
  --repo-root out \
  --source out/content-approval.md=examples/crossref/content-approval.bpmn \
  --source out/editorial-review.md=examples/crossref/editorial-review.bpmn \
  --source out/content-tone.md=examples/crossref/content-tone.dmn \
  --source out/approval-priority.md=examples/crossref/approval-priority.dmn
```

#### Tracking deletions and generating a change summary: `--manifest`

Without `--manifest`, `publish-tree` has no way to notice a file was
*removed* from the repo - its `outline_id` lived only in that file's own
frontmatter, which disappeared along with the file. `--manifest <path>`
points at a JSON file (commit it, same as any other tracked file) that
records `{repoPath: {outlineId, title, contentHash}}` for everything
currently managed, independently of any single file's frontmatter:

```bash
node dist/cli.js publish-tree docs/**/*.md \
  --collection "Docs Sync" \
  --repo-root . \
  --manifest .outline-render-manifest.json \
  --prune \
  --commit "$(git rev-parse --short HEAD)"
```

Each run diffs this run's file set against the manifest's previous
contents (by content hash, not just presence) to classify every file as
added, changed, unchanged, or removed - and, if there's anything to
report, publishes a one-off summary doc (never updated after creation)
nested under a "Changes" document in the same collection, titled
`<UTC timestamp>_<commit>` if `--commit` is given.

`--prune` actually archives (Outline soft-delete/trash - reversible,
not `permanent`) documents whose repoPath disappeared from the repo.
Without it, a removed file is only reported (console warning + the
changes summary says "not yet archived") - `--manifest` alone never
deletes anything; matches `delete-collection`'s own `--yes` gate for a
destructive action this tool would otherwise take unattended in CI. This
was deliberately **not** built as "drop the whole collection and republish
everything" - that also would have worked, but at the cost of every
document getting a new id/URL on every single run (breaking any external
link to it, not just when something's actually removed) and destroying
comments and view history on every run rather than only on an actual
deletion.

An explicit rejected alternative worth knowing about: archiving a document
that still has children being published this run would risk orphaning
them, *if* archiving happened before the normal nesting pass. It doesn't -
pruning runs after phase 2's `documents.move` calls, which already
re-parent any surviving child to its next valid ancestor using only this
run's current file set (a removed index just isn't in that set anymore),
so there's nothing left pointing at the archived document by the time it's
archived. Confirmed against Outline's own `Document` model, which has no
destroy-cascades-to-children hook (only `Collection` does, for deleting an
entire collection) - so this ordering is load-bearing, not incidental.

#### Mapping the repo's own README onto the collection: `--root-as-collection`

Publishing a repo's own `README.md`/`index.md` normally creates a document
whose title just repeats the collection it lives in (a "Docs Sync"
collection containing a document also called "Docs Sync") - redundant,
since Outline collections have their own markdown-rendered landing page
(`description`, confirmed against Outline's own schema - the same field
`getOrCreateCollection` already sets a placeholder into at creation).
`--root-as-collection` maps the repo's top-level README/index into that
field instead of creating a document for it:

```bash
node dist/cli.js publish-tree README.md docs/**/*.md \
  --collection "Docs Sync" \
  --repo-root . \
  --root-as-collection
```

Files that would have nested under the root README instead land at the
collection's own top level (there's no document to nest under any more).
Cross-references to it from other files still resolve correctly - to the
collection's own URL rather than a document's.

Off by default: turning it on for a collection that already has a real
document there (from before this option was used) needs a one-time
migration, so it's an explicit opt-in rather than something that happens
silently the first time this runs. That migration is automatic once
enabled, though - the old document is archived (soft-delete, same as
`--prune`) and its `outline_id` frontmatter dropped, since nothing backs
it as a document any more.

Each render command also stamps a frontmatter `icon:` field (a plain emoji)
into its output, matched to the source format (🔌 openapi, 🗄️ prisma, 🔀
bpmn, 🎯 dmn, 🧊 cube) - `publish` reads it and sets it as the document's
icon in Outline (confirmed against Outline's own `documents.create`/
`documents.update` schema, which accepts a plain emoji character there).
This is a CLI-layer concern only: the renderer functions themselves return
plain markdown with no frontmatter, so calling them directly (as the tests
do) is unaffected.

## Using this from a client repo

This project has no opinion on who calls it or from where - any repo that
wants "render some source file(s), then push the result into our Outline"
can consume it and wire that up with its own workflow/npm script and its
own env vars/CI secrets. It doesn't own a particular collection, Outline
instance, or org; those are all just configuration a client repo supplies.

### From GitHub Actions (recommended)

This repo is itself a composite action (`action.yml` at the root) - it
installs `outline-render` and puts it on `PATH` for the rest of the job, so
later steps just call it like a normal CLI:

```yaml
# a client repo's own .github/workflows/docs-sync.yml
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <your-org>/outline-render@main
        with:
          outline-api-key: ${{ secrets.OUTLINE_API_KEY }}
          outline-collection: "Docs Sync"
      - run: outline-render openapi docs/api-spec.yaml > docs/api-docs.md
      - run: outline-render publish docs/api-docs.md
      # publish rewrites outline_id into the published file's frontmatter -
      # commit that back, or every run looks like a first publish and
      # creates a duplicate instead of updating the same document.
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "Sync outline_id from Outline publish"
```

For a whole doc tree triggered on push/merge, `--manifest` needs `git.sha`
for the changelog and the same commit-back step, now also covering the
manifest file:

```yaml
- uses: <your-org>/outline-render@main
  with:
    outline-api-key: ${{ secrets.OUTLINE_API_KEY }}
    outline-collection: "Docs Sync"
- run: |
    outline-render publish-tree README.md docs/**/*.md \
      --repo-root . \
      --manifest .outline-render-manifest.json \
      --prune \
      --commit "${GITHUB_SHA::7}"
- uses: stefanzweifel/git-auto-commit-action@v5
  with:
    commit_message: "Sync outline_id/manifest from Outline publish-tree"
    file_pattern: "**/*.md .outline-render-manifest.json"
```

`with:` inputs: `version` (git ref to install, default `main` - pin to a
tag/commit once this repo has releases), `node-version` (default `22`),
`outline-api-key`/`outline-api-url`/`outline-collection` (all optional,
exported as the matching env vars for later steps - `--collection`/
`--api-url` flags still override them per-command). The action is
deliberately a thin installer, not a wrapper around every CLI flag: it
doesn't try to mirror openapi/prisma/bpmn/dmn/cube's own options or
`publish-tree`'s several flags as `with:` inputs, since that surface would
just drift out of sync with the CLI's own. Client repos write normal
`outline-render ...` steps instead.

### From an npm script, or without installing anything at all

```json
{
  "scripts": {
    "docs:sync": "outline-render openapi docs/api-spec.yaml > docs/api-docs.md && outline-render publish docs/api-docs.md"
  }
}
```

```bash
npm install git+https://github.com/<your-org>/outline-render.git
OUTLINE_API_KEY=... OUTLINE_API_URL=... OUTLINE_COLLECTION=... npm run docs:sync
```

Or via `npx`, no install step at all:

```bash
npx github:<your-org>/outline-render openapi docs/api-spec.yaml > docs/api-docs.md
```

`npm install`/`npx` on a git URL runs this package's own `prepare` script
(`npm run build`) automatically, so there's no separate build step to
remember on the consuming side.

## Renderer status

| Renderer | Status | Dependency |
|---|---|---|
| `openapi` | Working | [`yaml`](https://www.npmjs.com/package/yaml) (only for `.yaml`/`.yml` specs — `.json` needs nothing extra) |
| `prisma` | Working | none — the schema DSL parses fine with plain line scanning |
| `bpmn` | Working (Camunda 8 / Zeebe only) | [`bpmn-moddle`](https://www.npmjs.com/package/bpmn-moddle) + [`zeebe-bpmn-moddle`](https://www.npmjs.com/package/zeebe-bpmn-moddle) — the schema-aware model layer bpmn-js itself is built on, without bpmn-js's DOM-rendering dependencies (diagram-js, tiny-svg, min-dom) which this text-extraction CLI doesn't need. See `src/renderers/bpmn.ts`'s docstring for what's deliberately out of scope (Camunda 7's `camunda:` namespace attributes, user/timer/boundary elements, pools/lanes) until there's a real file to build those against |
| `dmn` | Working | [`dmn-moddle`](https://www.npmjs.com/package/dmn-moddle) — same relationship to dmn-js as bpmn-moddle has to bpmn-js. See `src/renderers/dmn.ts`'s docstring for scope limits (decision requirements diagrams, boxed expressions) |
| `cube` | Working (JavaScript cube definitions only) | [`acorn`](https://www.npmjs.com/package/acorn) — the real files this was built against (comments, template literals, bare-identifier references in `pre_aggregations`) rule out regex/line-scanning the way the Prisma renderer gets away with, and rule out `eval`-ing untrusted-ish source; acorn parses to a real AST instead. YAML cube definitions (`cube.yml`) are a different, still-unbuilt format - see `src/renderers/cube.ts`'s docstring for scope limits (`segments`, `pre_aggregations`, `joins` aren't rendered) |
| events / event catalogue | Not started | Scope still open — "consuming event data" could mean a lot of different things (a schema registry? sampling a live stream? something else?) - needs scoping before it's a renderer at all |

All working renderers produce the same shape of output on purpose: one
section per model/cube/schema/process/decision, a table underneath (field
+ type + description; or task + worker type + retries; or a decision
table's input/output matrix). A data catalogue pulling from multiple
source formats should read as one consistent document, not several
different styles glued together.

## Adding a new renderer

1. Create `src/renderers/<name>.ts`
2. Implement `render(path: string, options: RenderOptions): Promise<string> | string`
   (see `renderers/base.ts` for the contract)
3. Register it in `src/cli.ts`'s `RENDERERS` map
4. Add an example source file under `examples/` and a `<name>.test.ts` under
   `src/renderers/` that exercises it against that example — every existing
   renderer was built and debugged against a real (or realistic) example
   file, not speculatively. Two real bugs were caught this way already: a
   markdown-table-breaking formatting bug in the OpenAPI renderer, and a
   nested-parentheses parsing bug in the Prisma renderer that silently
   truncated `@default(autoincrement())` to `@default(autoincrement()`.

## Testing

No test framework dependency required — tests use Node's built-in test
runner (`node:test`):

```bash
npm test
```

## Status

Not yet published to a package registry - install straight from git
(`npm install git+https://...`, or `npx github:<org>/outline-render`)
until it is. See "Using this from a client repo" above.
