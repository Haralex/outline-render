#!/usr/bin/env node
/**
 * outline-render <format> <source-file> [options] > output.md
 * outline-render publish <markdown-file> --collection <name>
 * outline-render delete-collection <name> --yes
 *
 * The render commands dispatch to one of the renderers in src/renderers/ by
 * name. Each renderer implements render(path, options) -> string (see
 * renderers/base.ts) and knows nothing about Outline - `publish` and
 * `delete-collection` are the separate, explicit step that talks to
 * Outline's API (see src/outline.ts), kept in their own module rather than
 * folded into the renderers so "produce markdown" and "push markdown
 * somewhere" stay independently testable and swappable.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { render as openapi, ICON as OPENAPI_ICON } from "./renderers/openapi.js";
import { render as prisma, ICON as PRISMA_ICON } from "./renderers/prisma.js";
import { render as cube, ICON as CUBE_ICON } from "./renderers/cube.js";
import { render as bpmn, ICON as BPMN_ICON } from "./renderers/bpmn.js";
import { render as dmn, ICON as DMN_ICON } from "./renderers/dmn.js";
import type { Renderer, RenderOptions } from "./renderers/base.js";
import { loadConfig, publish, publishTree, deleteCollection, OutlineError } from "./outline.js";

// A .env file is optional (CI should inject real env vars via secrets
// instead) - only load one if it's actually there.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const RENDERERS: Record<string, Renderer> = { openapi, prisma, cube, bpmn, dmn };

// Stamped into rendered output as frontmatter so `publish` can set a
// matching document icon in Outline (documents.create/update accept a
// plain emoji in their `icon` field - confirmed against Outline's own
// server schema, not guessed). Purely a CLI-layer concern: the renderer
// functions themselves stay pure markdown-in, markdown-out with no
// frontmatter, so calling them directly (as the tests do) is unaffected.
// Each renderer module exports its own ICON - the single source of truth
// publish-tree's own bpmn/dmn source-rendering also reads from, rather
// than a second copy of these emoji living here too.
const FORMAT_ICONS: Record<string, string> = {
  openapi: OPENAPI_ICON,
  prisma: PRISMA_ICON,
  bpmn: BPMN_ICON,
  dmn: DMN_ICON,
  cube: CUBE_ICON,
};

function usage(): string {
  return (
    "outline-render <format> <source-file> [--title TITLE] [--option value ...]\n" +
    "outline-render publish <markdown-file> --collection <name>\n" +
    "outline-render publish-tree <file...> --collection <name> --repo-root <dir> [--github-base <url>] [--source <md-path>=<bpmn-or-dmn-path> ...] [--manifest <path> [--prune] [--commit <sha>]] [--root-as-collection]\n" +
    "outline-render delete-collection <name> --yes\n\n" +
    `format must be one of: ${Object.keys(RENDERERS).sort().join(", ")}`
  );
}

/** Parses trailing `--flag value` pairs into a plain object - the CLI's
 * pass-through option style, shared by the render and publish commands. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!flag.startsWith("--")) {
      console.error(`error: unrecognized argument ${JSON.stringify(flag)}`);
      process.exit(2);
    }
    const key = flag.slice(2).replace(/-/g, "_");
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true; // bare boolean switch, e.g. --yes
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

async function runRender(format: string, sourceFile: string | undefined, rest: string[]): Promise<void> {
  if (!(format in RENDERERS)) {
    console.error(`error: unrecognized format ${JSON.stringify(format)}\n\n${usage()}`);
    process.exit(2);
  }
  if (!sourceFile) {
    console.error(`error: missing source-file\n\n${usage()}`);
    process.exit(2);
  }

  const flags = parseFlags(rest);
  const options: RenderOptions = {};
  for (const [key, value] of Object.entries(flags)) {
    options[key] = typeof value === "boolean" ? String(value) : value;
  }

  const renderFn = RENDERERS[format];
  try {
    const output = await renderFn(sourceFile, options);
    const icon = FORMAT_ICONS[format];
    console.log(icon ? `---\nicon: ${icon}\n---\n\n${output}` : output);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.error(`error: ${sourceFile} not found`);
      process.exit(1);
    }
    console.error(`error: ${err?.message ?? err}`);
    process.exit(1);
  }
}

async function runPublish(markdownFile: string | undefined, rest: string[]): Promise<void> {
  if (!markdownFile) {
    console.error(`error: missing markdown-file\n\n${usage()}`);
    process.exit(2);
  }
  const flags = parseFlags(rest);
  const collection = typeof flags.collection === "string" ? flags.collection : process.env.OUTLINE_COLLECTION;
  if (!collection) {
    console.error("error: publish needs --collection <name> (or set OUTLINE_COLLECTION in .env)");
    process.exit(2);
  }

  try {
    const config = loadConfig(typeof flags.api_url === "string" ? flags.api_url : undefined);
    await publish(markdownFile, collection, config);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.error(`error: ${markdownFile} not found`);
      process.exit(1);
    }
    console.error(`error: ${err instanceof OutlineError ? err.message : (err?.message ?? err)}`);
    process.exit(1);
  }
}

async function runPublishTree(allArgs: string[]): Promise<void> {
  // Positional file args come first, then flags - unlike the other
  // commands this can take an arbitrary number of files, so it can't
  // reuse the single-target/rest split main() does for everything else.
  const firstFlagIdx = allArgs.findIndex((a) => a.startsWith("--"));
  const fileArgs = firstFlagIdx === -1 ? allArgs : allArgs.slice(0, firstFlagIdx);
  const flagArgs = firstFlagIdx === -1 ? [] : allArgs.slice(firstFlagIdx);

  if (fileArgs.length === 0) {
    console.error(`error: publish-tree needs at least one file\n\n${usage()}`);
    process.exit(2);
  }

  // --source <md-path>=<bpmn-or-dmn-path> is repeatable (a batch can pair
  // more than one rendered file with its source), unlike every other flag
  // here - so it's pulled out before the generic single-value parseFlags.
  const sourcePairs: string[] = [];
  const remainingFlagArgs: string[] = [];
  for (let i = 0; i < flagArgs.length; i += 1) {
    if (flagArgs[i] === "--source") {
      const pair = flagArgs[i + 1];
      if (!pair) {
        console.error("error: --source needs <md-path>=<bpmn-or-dmn-path>");
        process.exit(2);
      }
      sourcePairs.push(pair);
      i += 1;
      continue;
    }
    remainingFlagArgs.push(flagArgs[i]);
  }

  const flags = parseFlags(remainingFlagArgs);
  const collection = typeof flags.collection === "string" ? flags.collection : process.env.OUTLINE_COLLECTION;
  if (!collection) {
    console.error("error: publish-tree needs --collection <name> (or set OUTLINE_COLLECTION in .env)");
    process.exit(2);
  }
  const repoRoot = typeof flags.repo_root === "string" ? path.resolve(flags.repo_root) : process.cwd();
  const githubBase = typeof flags.github_base === "string" ? flags.github_base.replace(/\/$/, "") : undefined;
  const absFiles = fileArgs.map((f) => path.resolve(f));

  const sources = new Map<string, string>();
  for (const pair of sourcePairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      console.error(`error: --source ${JSON.stringify(pair)} isn't <md-path>=<bpmn-or-dmn-path>`);
      process.exit(2);
    }
    sources.set(path.resolve(pair.slice(0, eq)), path.resolve(pair.slice(eq + 1)));
  }

  const manifestPath = typeof flags.manifest === "string" ? path.resolve(flags.manifest) : undefined;
  const prune = flags.prune === true;
  const commit = typeof flags.commit === "string" ? flags.commit : undefined;
  const rootAsCollectionDescription = flags.root_as_collection === true;
  if (prune && !manifestPath) {
    console.error("error: --prune needs --manifest <path> (nothing to diff against without one)");
    process.exit(2);
  }

  try {
    const config = loadConfig(typeof flags.api_url === "string" ? flags.api_url : undefined);
    await publishTree(absFiles, repoRoot, collection, config, {
      githubBlobBaseUrl: githubBase,
      sources,
      manifestPath,
      prune,
      commit,
      rootAsCollectionDescription,
    });
  } catch (err: any) {
    console.error(`error: ${err instanceof OutlineError ? err.message : (err?.message ?? err)}`);
    process.exit(1);
  }
}

async function runDeleteCollection(collectionNameArg: string | undefined, rest: string[]): Promise<void> {
  const collectionName = collectionNameArg || process.env.OUTLINE_COLLECTION;
  if (!collectionName) {
    console.error(`error: missing collection name (or set OUTLINE_COLLECTION in .env)\n\n${usage()}`);
    process.exit(2);
  }
  const flags = parseFlags(rest);
  if (flags.yes !== true) {
    console.error(
      `error: this permanently deletes the "${collectionName}" collection and every document in it - pass --yes to confirm.`
    );
    process.exit(2);
  }

  try {
    const config = loadConfig(typeof flags.api_url === "string" ? flags.api_url : undefined);
    await deleteCollection(collectionName, config);
  } catch (err: any) {
    console.error(`error: ${err instanceof OutlineError ? err.message : (err?.message ?? err)}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(usage());
    process.exit(argv.length === 0 ? 2 : 0);
  }

  // The positional "target" arg (source file / collection name) is
  // optional for delete-collection (it can fall back to OUTLINE_COLLECTION)
  // - if what follows the command looks like a flag, there's no target.
  const [command, ...restArgs] = argv;
  const target = restArgs[0]?.startsWith("--") ? undefined : restArgs[0];
  const rest = target === undefined ? restArgs : restArgs.slice(1);

  if (command === "publish") {
    await runPublish(target, rest);
  } else if (command === "publish-tree") {
    await runPublishTree(restArgs);
  } else if (command === "delete-collection") {
    await runDeleteCollection(target, rest);
  } else {
    await runRender(command, target, rest);
  }
}

main();
