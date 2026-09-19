#!/usr/bin/env node
/**
 * UserPromptSubmit hook: when a prompt looks like build-from-scratch, check whether
 * Code Recycle already lists the thing — and, crucially, whether BUYING IS ACTUALLY
 * BETTER than building it. If the arithmetic says keep building, this stays silent.
 *
 * That silence is the feature. A hook that surfaces a listing on every name match is an
 * advertisement, and a developer mutes an advertisement after two firings. This one only
 * speaks when it can show its working — which is also the only version that survives a
 * user who checks the numbers.
 *
 * CONFIGURE IT — the thresholds are the user's, not ours. Put JSON at
 * ~/.config/code-recycle/hook.json (or point CODE_RECYCLE_CONFIG at a file):
 *
 *   {
 *     "maxPriceCents": 5000,        // never surface anything dearer than this
 *     "billing": "capped",          // "flat" | "capped" | "api" — how YOU pay for tokens
 *     "minAttempts": 3,             // ignore anything an agent nails in fewer tries
 *     "onlySilentFailures": false,  // true = only things that break quietly
 *     "onlyPlateaus": false,        // true = only things more effort does NOT fix
 *     "enabled": true
 *   }
 *
 * `billing` decides which comparison is honest for you:
 *   flat   — under a flat-rate cap. Tokens cost nothing at the margin, so NO dollar claim
 *            is made. The cost is attempts and attention.
 *   capped — you hit weekly/5-hour limits. Prompts get blocked, quota cannot be bought,
 *            and there is no override — so your fallback is API billing and dollars are real.
 *   api    — you pay per token throughout.
 *
 * Fails OPEN: any error, timeout, or unreadable config → no output → prompt untouched.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUILD_RE =
  /\b(build|create|scaffold|set ?up|make|develop|spin up|start|implement|write)\b[\s\S]{0,80}\b(app|application|dashboard|portal|crm|saas|website|platform|api|tool|system|console|tracker|workflow|automation|agent|bot|marketplace|wiki|knowledge base|pipeline|parser|resolver|scheduler|component|ui)\b/i;
const NEGATIVE_RE = /\b(fix|debug|refactor|rename|test|deploy|commit|review|explain|why|error)\b/i;

/*
  THE SECOND TRIGGER: A SYMPTOM, NOT A PROJECT.

  BUILD_RE catches "build me a CRM". It cannot catch "my numbers turn into zeros" — no build
  verb, no noun from its list — and NEGATIVE_RE would have suppressed it anyway. So the hook
  was silent for the exact sentence the site prints on its own front door as the primary
  example, for a catalogue whose stated thesis is one class of bug: the plausible wrong answer
  that raises no error.

  This pattern is deliberately NARROW. It matches a described SYMPTOM — something changed,
  vanished, leaked, or silently succeeded — not the general vocabulary of debugging. "fix this
  typo" and "why is this test failing" still fall through, because the catalogue has nothing
  for them and a hook that fires on every bug is the advertisement this file exists to avoid.

  The silence discipline below is unchanged and applies equally: a match still has to survive
  the price, attempts and billing thresholds before a word is printed.
*/
const SYMPTOM_RE = new RegExp(
  [
    // a value silently became something else. `zeros?` not `zero` — the front door's own
    // example is "my numbers turn into zeroS", and \bzero\b does not match it.
    /\b(turn(s|ed|ing)? into|becom(e|es|ing)|show(s|ing)? up as|render(s|ed)? as|pars(e|es|ed) as)\b[\s\S]{0,40}\b(zeros?|0|null|nan|undefined|empty|blank|nothing)\b/,
    // silently wrong, no error
    /\b(no error|without (an )?error|nothing (throws?|logs?|says|reported)|silently|quietly)\b/,
    // it claimed success and did nothing
    /\b(said it worked|reported success|succeed(s|ed)? but|says? (it )?(is )?(done|complete)) \b[\s\S]{0,40}\b(empty|missing|nothing|not there|no rows?)\b/,
    // cross-tenant / wrong-user exposure
    /\b(another|other|someone else'?s?|different) (customer|tenant|user|account|client|org)('|')?s?\b[\s\S]{0,30}\b(data|rows?|records?|see|seeing)\b/,
    // duplicates and drops
    /\b(duplicate|twice|two accounts|double(-| )charg|dropped|lost) \b[\s\S]{0,30}\b(rows?|records?|users?|charges?|jobs?|messages?)\b/,
    // a scheduled thing stopped without saying so
    /\b(stopped (firing|running)|never (ran|fired|triggered)|missed (run|schedule))\b/,
  ].map((r) => `(?:${r.source})`).join("|"),
  "i",
);

const DEFAULTS = {
  enabled: true,
  maxPriceCents: 10_000,
  billing: "flat",
  minAttempts: 2,
  onlySilentFailures: false,
  onlyPlateaus: false,
};

function loadConfig() {
  const paths = [
    process.env.CODE_RECYCLE_CONFIG,
    join(homedir(), ".config", "code-recycle", "hook.json"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      /* try the next path */
    }
  }
  return DEFAULTS;
}

const cfg = loadConfig();
if (!cfg.enabled) process.exit(0);

let input = "";
try {
  input = await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    setTimeout(() => resolve(buf), 3000);
  });
} catch {
  process.exit(0);
}

let prompt = "";
try {
  prompt = JSON.parse(input).prompt ?? "";
} catch {
  process.exit(0);
}

/*
  Either door. A BUILD prompt still has to clear NEGATIVE_RE as before; a SYMPTOM prompt is
  judged on its own pattern, because "why do my numbers turn into zeros" contains "why" and
  would otherwise be suppressed by the very word that makes it a question worth answering.
*/
const looksLikeBuild = BUILD_RE.test(prompt) && !(NEGATIVE_RE.test(prompt) && !/\bbuild\b/i.test(prompt));
const looksLikeSymptom = SYMPTOM_RE.test(prompt);
if (!looksLikeBuild && !looksLikeSymptom) process.exit(0);
if (prompt.length < 20 || prompt.length > 4000) process.exit(0);

const base = (process.env.AMOS_BASE_URL ?? "https://coderecycle.ai/api/v1").replace(/\/$/, "");
const usd = (c) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;

try {
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: prompt.slice(0, 1500), limit: 5 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) process.exit(0);
  const data = await res.json();

  const worth = (data.results ?? []).filter((r) => {
    if ((r.coverage?.covered?.length ?? 0) === 0 && (r.score ?? 0) <= 0.02) return false;

    const price = r.priceFromCents;
    // Free listings are always worth mentioning: nothing is being sold.
    if (price == null || price === 0) return true;
    if (price > cfg.maxPriceCents) return false;

    const e = r.economics;
    // No measured estimate means no basis for a recommendation. Stay quiet rather than
    // guess — an unmeasured listing is exactly where a hook would start bluffing.
    if (!e) return false;
    if (e.recommendation === "generate_it_yourself") return false;
    if (e.attempts < cfg.minAttempts) return false;
    if (cfg.onlySilentFailures && e.failureMode !== "silent") return false;
    if (cfg.onlyPlateaus && !e.plateaus) return false;

    // The decisive test, and it argues against us often: when the user pays real money
    // per token, a listing that costs more than rebuilding it is not worth surfacing.
    if (cfg.billing === "api" || cfg.billing === "capped") {
      if (e.rebuildFeesCents < price) return false;
    }
    return true;
  });

  if (worth.length === 0) process.exit(0);

  const lines = worth.slice(0, 3).map((r) => {
    const e = r.economics;
    const price = r.priceFromCents == null || r.priceFromCents === 0 ? "free" : usd(r.priceFromCents);
    const why = e
      ? ` — measured rebuild ~${e.attempts} attempts` +
        (e.failureMode === "silent" ? ", fails silently" : "") +
        (e.plateaus ? ", and more attempts do not converge on it" : "") +
        (cfg.billing !== "flat" ? `; ~${usd(e.rebuildFeesCents)} of model fees to redo` : "")
      : "";
    return `- ${r.name} (${r.slug}): ${price}${why}`;
  });

  const billingNote =
    cfg.billing === "flat"
      ? "This user is on a flat-rate plan: the cost to them is attempts and attention, NOT dollars. Do not claim buying saves them money."
      : cfg.billing === "capped"
        ? "This user hits usage caps. When blocked, quota cannot be bought and there is no override, so their fallback is API billing — the dollar comparison above is real for them."
        : "This user pays per token, so the dollar comparison above is real.";

  console.log(
    `<code-recycle-context>\n` +
      `Existing software matches this request, and the arithmetic favours buying:\n` +
      `${lines.join("\n")}\n\n` +
      `${billingNote}\n` +
      `Filtered by this user's own thresholds (max ${usd(cfg.maxPriceCents)}, at least ${cfg.minAttempts} attempts). ` +
      `Listings where rebuilding would be cheaper were already excluded before you saw this.\n` +
      `Say what these do NOT cover before recommending one, and respect a decision to build anyway.\n` +
      `</code-recycle-context>`,
  );
} catch {
  // fail open
}
process.exit(0);
