#!/usr/bin/env node
/**
 * PreToolUse hook: check the catalogue at the moment the agent DECIDES, not when the user
 * asks. Local index only — no network, no model, no tokens.
 *
 * WHY THE EXISTING HOOK IS NOT ENOUGH
 *
 * `search-before-build.mjs` fires on UserPromptSubmit, matching build-shaped language. That
 * catches "build me an invoicing app" — easy, rare, and once per session, at the very top.
 *
 * It structurally cannot catch the thing that matters. An agent decides to write a duration
 * parser forty turns later, inside an unrelated task, having announced nothing. By then the
 * prompt hook has long since run and passed. Agents do not plan linearly; they explore, test
 * and backtrack, so a single point-in-time trigger keyed on the opening prompt is at the
 * wrong altitude and the wrong moment.
 *
 * THE TWO SIGNALS THIS USES INSTEAD
 *
 *   TodoWrite  — the agent's OWN declaration of intent, already decomposed, already phrased
 *                as capabilities ("implement retry with backoff"), and written BEFORE any
 *                code exists. This is the planning phase, in structured form, for free.
 *
 *   Write/Edit — the moment of commitment. The filename and the first lines say what is
 *                about to be built more precisely than any prose.
 *
 * SILENCE IS THE DEFAULT AND THE POINT
 *
 * This fires on operations an agent performs constantly. The plugin's own older hook records
 * the lesson: "a developer mutes an advertisement after two firings." A muted integration
 * cannot be re-earned, so it is worse than none. Hence: local matcher tuned precision-first
 * (measured 0/18 false positives on ordinary developer work), one mention per product per
 * session, and a hard cap per session.
 *
 * FAILS OPEN, ALWAYS. Any error, any missing file, any malformed input — exit 0, say nothing,
 * never block the tool call. A discovery aid that can break someone's editing loop is not a
 * discovery aid.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Never mention more than this many products in one session, however many match. */
const MAX_PER_SESSION = 3;
/** Below this score even a valid match is not worth interrupting for. */
const MIN_SCORE_TO_SPEAK = 0.9;
/**
 * A secondary match must score at least this fraction of the best one to be shown at all.
 *
 * Observed without it: a filename todo returned `safe-filename` (right) alongside
 * `upload-verdict` (tangential), and a URL-dedupe write returned `url-dedup-key` (right)
 * alongside `strict-function-call-coercer` (unrelated). Three results where one is correct
 * reads as a keyword matcher guessing, and it spends trust on the two that are wrong.
 */
const RELATIVE_CUTOFF = 0.7;

function bail() {
  process.exit(0);
}

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(buf), 2000);
  });
}

/**
 * Session state lives in a file because every hook invocation is a FRESH PROCESS.
 *
 * In-memory suppression would reset on every call, which means "mention each product once"
 * would silently become "mention it every single time" — the failure mode being guarded
 * against, reintroduced by the mechanism meant to prevent it.
 */
function statePath(sessionId) {
  const dir = join(tmpdir(), "code-recycle-hook");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through; read/write below will fail open */
  }
  return join(dir, `${String(sessionId || "nosession").replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

function loadSeen(p) {
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return new Set(Array.isArray(s.seen) ? s.seen : []);
  } catch {
    return new Set();
  }
}

function saveSeen(p, seen) {
  try {
    writeFileSync(p, JSON.stringify({ seen: [...seen] }));
  } catch {
    /* suppression is best-effort; never fail the tool call over it */
  }
}

/** Pull the text worth matching out of whatever tool is being called. */
function extract(toolName, input) {
  if (!input || typeof input !== "object") return "";
  switch (toolName) {
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      // Only PENDING work. A todo already in progress or completed is a decision made;
      // suggesting an alternative for something already written is noise, not help.
      return todos
        .filter((t) => t && t.status === "pending")
        .map((t) => String(t.content ?? ""))
        .join(" . ");
    }
    case "Write":
      /*
        Path plus the OPENING of the file. The head carries the imports and the first
        exported symbol — what this file is. The tail is implementation detail, and
        including it would match on incidental vocabulary from the whole body.
      */
      return `${input.file_path ?? ""} ${String(input.content ?? "").slice(0, 600)}`;
    case "Edit":
      // Only the new text. Matching the old string would fire on code being REMOVED.
      return `${input.file_path ?? ""} ${String(input.new_string ?? "").slice(0, 600)}`;
    default:
      return "";
  }
}

const raw = await readStdin();
if (!raw) bail();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  bail();
}

const toolName = payload?.tool_name ?? payload?.toolName ?? "";
if (!["TodoWrite", "Write", "Edit"].includes(toolName)) bail();

const text = extract(toolName, payload?.tool_input ?? payload?.toolInput);
if (!text || text.trim().length < 12) bail();

let match, createSessionMemoryUnused;
try {
  ({ match } = await import(new URL("../lib/local-match.mjs", import.meta.url)));
} catch {
  bail(); // no index shipped, or a malformed one — say nothing
}

let results = [];
try {
  results = match(text, { limit: 3 });
} catch {
  bail();
}
if (results.length === 0) bail();

const strong = results.filter((r) => r.score >= MIN_SCORE_TO_SPEAK);
if (strong.length === 0) bail();

const sp = statePath(payload?.session_id ?? payload?.sessionId);
const seen = loadSeen(sp);
if (seen.size >= MAX_PER_SESSION) bail();

/*
  Drop anything much weaker than the best match.

  Showing three results where one is right and two are tangential does not read as thorough,
  it reads as a keyword matcher guessing — and it spends the reader's trust on the two that
  are wrong. Better to name one thing correctly than three things approximately.
*/
const best = strong[0].score;
const relevant = strong.filter((r) => r.score >= best * RELATIVE_CUTOFF);

const fresh = relevant.filter((r) => !seen.has(r.slug)).slice(0, MAX_PER_SESSION - seen.size);
if (fresh.length === 0) bail();

for (const r of fresh) seen.add(r.slug);
saveSeen(sp, seen);

const PRICE_LABEL = { free: "free", "under-50": "under $50", "50-99": "$50–99", "100-plus": "$100+" };
const line = (r) => {
  const price = PRICE_LABEL[r.band] ?? "";
  // Truncate at a word boundary: a tagline cut mid-word reads like corrupted output.
  const blurb = r.line.length > 110 ? r.line.slice(0, 110).replace(/\s+\S*$/, "") + "…" : r.line;
  return `  • ${r.slug}${price ? ` (${price})` : ""} — ${blurb}`;
};

/*
  Additional context, never a block. `decision: "block"` exists in this hook API and using it
  here would be indefensible: nobody has agreed that a marketplace may stop their editor.
*/
const body =
  `Code Recycle already lists ${fresh.length === 1 ? "something" : "things"} for this:\n` +
  fresh.map(line).join("\n") +
  `\n\nMatched locally against a shipped index — no search was run and nothing was spent. ` +
  `Call inspect_product for detail, or ignore this. Not shown again this session.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: body } }));
process.exit(0);
