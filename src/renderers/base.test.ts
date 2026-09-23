import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, buildToc } from "./base.js";

test("slugify: matches Outline's own heading anchor format, not GitHub's", () => {
  // Regression test: an earlier version of slugify() produced GitHub-style
  // slugs (no prefix), which silently produced dead TOC links - Outline's
  // own heading anchors all carry an "h-" prefix (confirmed by reading
  // Outline's shared/editor/lib/headingToSlug.ts, not guessed).
  assert.equal(slugify("Account"), "h-account");
  assert.equal(slugify("OrderStatus (enum)"), "h-orderstatus-enum");
  assert.equal(slugify("Content Approval (process)"), "h-content-approval-process");
});

test("slugify: collapses whitespace and trims, same as Outline's slugify() call", () => {
  assert.equal(slugify("  Extra   Spaces  "), "h-extra-spaces");
});

test("slugify: uses Outline's own charmap, e.g. '&' becomes 'and' rather than being stripped", () => {
  assert.equal(slugify("Site & Keyword"), "h-site-and-keyword");
});

test("slugify: strips punctuation outside Outline's charmap without leaving stray separators", () => {
  assert.equal(slugify("C++ Renderer"), "h-c-renderer");
});

test("slugify: preserves existing hyphens", () => {
  assert.equal(slugify("already-hyphenated-name"), "h-already-hyphenated-name");
});

test("buildToc: disambiguates duplicate headings with the same -N suffix Outline itself would use", () => {
  const out = buildToc(["Foo", "Foo", "Foo"]);
  assert.match(out, /- \[Foo\]\(#h-foo\)\n- \[Foo\]\(#h-foo-1\)\n- \[Foo\]\(#h-foo-2\)/);
});
