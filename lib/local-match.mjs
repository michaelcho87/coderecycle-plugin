/**
 * Match a phrase against the catalogue LOCALLY — no network, no model, no tokens.
 *
 * WHY THIS IS THE FRONT DOOR
 *
 * Measured, the cheapest remote search is ~1,631 tokens and 5-10 seconds. The most common
 * answer is "we have nothing for that", and paying that price to hear it — repeatedly, since
 * an agent asks many times per session — is the worst trade in the system.
 *
 * So the network is the fallback. This is the front door. It answers "no" instantly and for
 * nothing, and only a HIT justifies spending anything at all.
 *
 * PRECISION IS THE WHOLE DESIGN, NOT A TUNING DETAIL
 *
 * This runs on things an agent does constantly — writing a file, adding a todo. A matcher that
 * fires often is an advertisement, and the plugin's own hook already records the lesson: "a
 * developer mutes an advertisement after two firings." A muted integration is worse than no
 * integration, because it also cannot be re-earned. So the bar is set to produce silence in
 * the ordinary case, and the tests assert the silence rather than only the hits.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, "..", "index", "catalog-index.json");

/**
 * A term must appear in at least this fraction of… no — see below.
 *
 * MIN_SIGNAL is an ABSOLUTE count of distinct matched terms, not a ratio. A ratio rewards
 * short entries: a listing with three terms scores 1.0 on a single coincidental word, which is
 * exactly how a matcher starts firing on everything.
 */
export const MIN_SIGNAL = 2;

/**
 * A term appearing in this many or more entries carries no information and is ignored.
 *
 * Derived from the corpus rather than guessed: with 254 entries, words like "data", "verdict"
 * or "safe" appear across dozens of listings, so matching one says nothing about which listing
 * is meant. Without this, any prompt containing "data" matches a third of the catalogue.
 *
 * SWEPT, not chosen. Measured against the eval set at four values:
 *
 *     ceiling   recall   false positives
 *        12      5/6          0/18
 *         8      3/6          0/18
 *         6      3/6          0/18
 *         5      3/6          0/18
 *
 * Tightening costs two real hits and buys NOTHING, because precision is already perfect. The
 * temptation was to tighten anyway, to remove a piece of visible ranking noise (a duration
 * query returning `tool-result-size-guard` on the generic pair [pars, str], df 10 and 5). That
 * would have traded two correct answers for one cosmetic one. Noise in the RANKING is not the
 * same defect as firing when it should be silent, and only the second one gets a plugin muted.
 */
export const MAX_DOC_FREQUENCY = 12;

/**
 * Words that describe what a developer DOES, never what a product IS.
 *
 * THIS EXISTS BECAUSE A SCORE THRESHOLD PROVABLY CANNOT DO THE JOB. Measured on the live
 * index, the weighted scores were:
 *
 *     true positives   1.50  1.43  1.02  0.60  0.58
 *     false positives              1.06        0.82
 *
 * The false positives sit INSIDE the true-positive range, so every cutoff that removes 1.06
 * also removes 1.02, 0.60 and 0.58. Tuning a number here would have looked like progress and
 * could not have worked.
 *
 * What actually separated them was the CONTENT of the match, not its strength:
 *
 *     "fix the failing test in auth.spec.ts"  ->  [auth, fail]
 *     "commit and push these changes"         ->  [chang, commit]
 *
 * Both are ordinary workflow verbs colliding by accident. No product is ABOUT committing or
 * failing, so a match resting on them is a coincidence however strongly it scores. These are
 * removed from the QUERY side only — a listing may legitimately contain "change" in its own
 * terms, and this must not delete it from the catalogue.
 */
const WORKFLOW_WORDS = new Set(
  [
    "fix", "fixe", "fail", "test", "commit", "chang", "push", "pull", "merg", "rebas",
    "deploy", "renam", "refactor", "bump", "updat", "upgrad", "instal", "add", "remov",
    "delet", "creat", "writ", "read", "run", "build", "check", "review", "clean", "mov",
    "debug", "log", "print", "todo", "fixm", "note", "question", "explain", "why", "how",
  ].map((w) => w),
);

/**
 * Fold a word to a comparable stem.
 *
 * ADDED AFTER MEASURING, not in anticipation. The first version matched raw words and missed
 * "dedupe urls before crawling" against `url-dedup-key`, because "urls" is not "url" and
 * "dedupe" is not "dedup". Two real recall failures from spelling alone.
 *
 * Deliberately crude — no Porter stemmer, no dictionary. Each rule below earns its place by
 * fixing an observed miss, and the false-positive rate is re-measured after every one. An
 * aggressive stemmer buys recall by collapsing distinct words together, which is precisely how
 * a matcher starts firing on everything.
 *
 * Never shortens below 3 characters: "ides" -> "id" would match far more than it should.
 */
function stem(w) {
  for (const suffix of ["ing", "ies", "ed", "es", "s", "e"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  }
  return w;
}

let cached = null;

export function loadIndex(path = INDEX_PATH) {
  if (cached && cached.__path === path) return cached;
  const raw = JSON.parse(readFileSync(path, "utf8"));

  /*
    Stems are computed on BOTH sides at load, never stored in the exported index. Storing them
    would freeze this function's behaviour into a file that ships separately from it, so
    changing a rule would silently apply to queries and not to entries.
  */
  const entries = raw.entries.map((e) => ({ ...e, stems: [...new Set(e.terms.map(stem))] }));

  // Document frequency, computed once, so common terms can be discounted.
  const df = new Map();
  for (const e of entries) for (const t of e.stems) df.set(t, (df.get(t) ?? 0) + 1);

  cached = { ...raw, entries, df, __path: path };
  return cached;
}

/** Split arbitrary text — a todo, a filename, a symbol — into comparable stems. */
export function tokenize(text) {
  if (typeof text !== "string") return new Set();
  return new Set(
    text
      // camelCase and PascalCase carry the intent in code; split them apart.
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map(stem)
      // Dropped from the QUERY only. A listing may legitimately use these words about itself.
      .filter((w) => !WORKFLOW_WORDS.has(w)),
  );
}

/**
 * Rank catalogue entries against a phrase.
 *
 * Returns [] far more often than not, and that is the intended behaviour rather than a
 * failure to match.
 */
export function match(text, opts = {}) {
  const { limit = 3, index = loadIndex(), minSignal = MIN_SIGNAL } = opts;
  const words = tokenize(text);
  if (words.size === 0) return [];

  const scored = [];
  for (const e of index.entries) {
    let signal = 0;
    const hits = [];
    for (const t of e.stems) {
      if (!words.has(t)) continue;
      const freq = index.df.get(t) ?? 1;
      if (freq > MAX_DOC_FREQUENCY) continue; // too common to mean anything
      signal += 1 / Math.log2(freq + 1); // rarer terms count for more
      hits.push(t);
    }
    if (hits.length < minSignal) continue;
    scored.push({ slug: e.slug, name: e.name, line: e.line, band: e.band, tier: e.tier, score: signal, matched: hits });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return scored.slice(0, limit);
}

/**
 * Remember what has already been raised, so the same topic is mentioned once.
 *
 * Keyed on the SLUG, not the phrase. An agent circles the same problem in different words, and
 * keying on wording would let one listing be surfaced five times in five phrasings — the exact
 * behaviour that gets an integration muted.
 */
export function createSessionMemory() {
  const seen = new Set();
  return {
    unseen(results) {
      return results.filter((r) => !seen.has(r.slug));
    },
    remember(results) {
      for (const r of results) seen.add(r.slug);
    },
    get size() {
      return seen.size;
    },
  };
}
