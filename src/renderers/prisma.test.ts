import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { render } from "./prisma.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "example-schema.prisma");

test("model and field docs", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Account/);
  assert.match(out, /Registered company name\./);
});

test("nested paren attribute not truncated", async () => {
  const out = await render(EXAMPLE);
  // Regression: a naive \([^)]*\) regex truncates a nested-paren default
  // like @default(dbgenerated("gen_random_uuid()")) at the first ')',
  // producing an unbalanced "...gen_random_uuid()" (missing the closing
  // paren for dbgenerated itself).
  assert.ok(out.includes('@default(dbgenerated("gen_random_uuid()"))'));
  assert.ok(!out.includes('@default(dbgenerated("gen_random_uuid()")' + " |")); // the truncated form
  assert.ok(out.includes("@default(autoincrement())"));
});

test("enum values keep their doc comments", async () => {
  const out = await render(EXAMPLE);
  assert.ok(out.includes("`PAID`"));
  assert.ok(out.includes("Payment confirmed, awaiting fulfilment."));
});

test("table level attribute surfaced", async () => {
  const out = await render(EXAMPLE);
  assert.ok(out.includes('@@map("accounts")'));
  assert.ok(out.includes('@@unique([orderId, productSku])'));
});

test("scalar fields get a type icon looked up by name", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| `name` \| 🔤 String \|/); // string
  assert.match(out, /\| `quantity` \| 🔢 Int \| @default\(1\)/); // int
  assert.match(out, /\| `isActive` \| ✅ Boolean \|/); // boolean
  assert.match(out, /\| `createdAt` \| 📅 DateTime \|/); // datetime
  assert.match(out, /\| `metadata` \| 🧾 Json\? \|/); // json
});

test("fields referencing another model or enum in the same file get the relation icon, not a scalar guess", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /\| `orders` \| 🔗 Order\[\] \|/); // Order[] relation
  assert.match(out, /\| `account` \| 🔗 Account \|/); // Account relation
  assert.match(out, /\| `status` \| 🔗 OrderStatus \|/); // enum reference, not a scalar
});

test("toc included by default", async () => {
  const out = await render(EXAMPLE);
  assert.match(out, /## Contents/);
  assert.ok(out.indexOf("## Contents") < out.indexOf("## Account"));
  assert.match(out, /- \[Account\]\(#h-account\)/);
  assert.match(out, /- \[OrderStatus \(enum\)\]\(#h-orderstatus-enum\)/);
});

test("toc can be disabled explicitly", async () => {
  const out = await render(EXAMPLE, { toc: "no" });
  assert.doesNotMatch(out, /## Contents/);
});
