/**
 * Precision-first tests for the local matcher.
 *
 *   node --test lib/local-match.test.mjs
 *
 * MOST OF THESE ASSERT SILENCE, on purpose. This runs on things an agent does constantly, and
 * the failure that kills the integration is not a missed match — it is firing on "commit and
 * push these changes" twice and being muted forever.
 *
 * THE EVAL SET IS SMALL: 6 positives, 18 negatives, hand-written. It is enough to have caught
 * three real design errors (no stemming, a score threshold that provably cannot separate, a
 * document-frequency ceiling that cost recall for nothing) and it is NOT enough to claim a
 * general precision figure. Treat a passing run as "the known failures stay fixed", not as
 * evidence the matcher is good.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { match, tokenize, createSessionMemory, loadIndex, MIN_SIGNAL, MAX_DOC_FREQUENCY } from "./local-match.mjs";

const index = loadIndex();

/** Ordinary developer sentences with nothing to do with the catalogue. */
const MUST_BE_SILENT = [
  "fix the failing test in auth.spec.ts",
  "rename this variable to something clearer",
  "add a button to the header",
  "update the README with install instructions",
  "why is this function returning undefined",
  "refactor this component into smaller pieces",
  "bump the node version in CI",
  "explain what this regex does",
  "commit and push these changes",
  "add a dark mode toggle",
  "write a migration to add a column",
  "the build is broken on main",
  "install the dependencies",
  "make the sidebar collapsible",
  "deploy to staging",
  "add logging to this handler",
  "increase the timeout",
  "delete the unused imports",
];

test("silent on ordinary developer work", () => {
  for (const phrase of MUST_BE_SILENT) {
    assert.deepEqual(match(phrase, { index }), [], `should not have fired on: ${phrase}`);
  }
});

test("silent on empty, whitespace and non-string input", () => {
  for (const junk of ["", "   ", "a", "ab", null, undefined, 42, {}]) {
    assert.deepEqual(match(junk, { index }), []);
  }
});

test("finds the right listing for phrases it should know", () => {
  const cases = [
    ["sanitize an uploaded filename before writing it to disk", "safe-filename"],
    ["dedupe urls before crawling", "url-dedup-key"],
    ["verify the stripe webhook signature", "webhook-signature-verify"],
  ];
  for (const [phrase, expected] of cases) {
    const slugs = match(phrase, { index, limit: 5 }).map((r) => r.slug);
    assert.ok(slugs.includes(expected), `${expected} not in [${slugs}] for "${phrase}"`);
  }
});

test("workflow verbs alone never produce a match", () => {
  /*
    Regression guard for the two measured false positives. Both were ordinary verbs colliding
    by accident — [auth, fail] and [chang, commit] — and both outscored real matches, which is
    why a score threshold could not have fixed them.
  */
  for (const phrase of ["commit these changes", "fix the failing build", "deploy and test", "rename and refactor"]) {
    assert.deepEqual(match(phrase, { index }), [], `workflow verbs fired on: ${phrase}`);
  }
});

test("camelCase and paths are split into their words", () => {
  /*
    Asserts the STEM, not the word. "file" ends in -e, so it folds to "fil" — an earlier
    version of this test looked for "file", failed, and the test was the thing that was wrong.
    Worth pinning explicitly: it means "file" and "filename" do NOT unify, which is correct
    (a filename product is not a file-handling product) but is not obvious.
  */
  const t = tokenize("sanitizeFileName");
  assert.ok(t.has("fil"), `expected stem "fil" in [${[...t]}]`);
  assert.ok(t.has("nam"), `expected stem "nam" in [${[...t]}]`);
  assert.ok(tokenize("src/lib/webhookSignature.ts").has("webhook"));
});

test("stems fold plurals and gerunds to the same token", () => {
  const t = tokenize("urls dedupe crawling");
  assert.ok(t.has("url"), "urls should stem to url");
  assert.ok(t.has("dedup"), "dedupe should stem to dedup");
});

test("never stems below three characters", () => {
  // "ides" -> "id" would match a great deal more than it should.
  for (const w of ["ides", "uses", "axes"]) {
    for (const tok of tokenize(w)) assert.ok(tok.length >= 3, `${w} stemmed to ${tok}`);
  }
});

test("a single matched term is never enough", () => {
  assert.equal(MIN_SIGNAL, 2);
  // A phrase carrying exactly one distinctive catalogue word must stay silent.
  assert.deepEqual(match("something about a webhook", { index }), []);
});

test("results are ordered, capped, and carry what a decision needs", () => {
  const r = match("verify the stripe webhook signature", { index, limit: 2 });
  assert.ok(r.length > 0 && r.length <= 2);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score, "not sorted by score");
  for (const x of r) {
    for (const field of ["slug", "name", "line", "band", "tier", "score", "matched"]) {
      assert.ok(x[field] !== undefined, `missing ${field}`);
    }
  }
});

test("the ceiling is the swept value, not a tightened one", () => {
  /*
    Pinned because tightening it is the obvious-looking change and it is wrong: at 8, 6 and 5
    recall drops from 5/6 to 3/6 while precision stays at 0/18. Anyone lowering this should
    have to delete this test and explain the sweep.
  */
  assert.equal(MAX_DOC_FREQUENCY, 12);
});

test("session memory suppresses a repeat of the same slug", () => {
  const mem = createSessionMemory();
  const first = match("sanitize an uploaded filename before writing it to disk", { index });
  assert.ok(first.length > 0);
  assert.equal(mem.unseen(first).length, first.length);
  mem.remember(first);
  assert.deepEqual(mem.unseen(first), []);
});

test("session memory keys on slug, not on wording", () => {
  const mem = createSessionMemory();
  mem.remember([{ slug: "safe-filename" }]);
  // A differently-worded question about the same product must still be suppressed.
  const again = match("clean up a user supplied filename", { index });
  assert.deepEqual(mem.unseen(again).filter((r) => r.slug === "safe-filename"), []);
});

test("the index is present, non-trivial, and dated", () => {
  assert.ok(index.count > 100, `only ${index.count} entries`);
  assert.equal(index.count, index.entries.length);
  assert.ok(Date.parse(index.generatedAt) > 0, "index has no usable generatedAt");
  // It must not carry the things that go stale dangerously.
  for (const e of index.entries.slice(0, 20)) {
    for (const forbidden of ["description", "offers", "licence", "license", "trustScore", "priceCents"]) {
      assert.equal(e[forbidden], undefined, `index should not carry ${forbidden}`);
    }
  }
});
