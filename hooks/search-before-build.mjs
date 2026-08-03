#!/usr/bin/env node
/**
 * UserPromptSubmit hook: when the prompt looks like a build-from-scratch request,
 * search Code Recycle (free public endpoint) and inject the top matches as
 * context. Deterministic — doesn't rely on the model choosing to check.
 *
 * Fails OPEN: any error/timeout → no output → the prompt proceeds untouched.
 */
const BUILD_RE =
  /\b(build|create|scaffold|set ?up|make|develop|spin up|start)\b[\s\S]{0,80}\b(app|application|dashboard|portal|crm|saas|website|platform|api|tool|system|console|tracker|workflow|automation|agent|bot|marketplace|wiki|knowledge base|pipeline)\b/i;
const NEGATIVE_RE = /\b(fix|debug|refactor|rename|test|deploy|commit|review|explain|why|error)\b/i;

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

if (!BUILD_RE.test(prompt) || (NEGATIVE_RE.test(prompt) && !/\bbuild\b/i.test(prompt))) process.exit(0);
if (prompt.length < 20 || prompt.length > 4000) process.exit(0);

const base = (process.env.AMOS_BASE_URL ?? "https://coderecycle.ai/api/v1").replace(/\/$/, "");

try {
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: prompt.slice(0, 1500), limit: 3 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) process.exit(0);
  const data = await res.json();
  const results = (data.results ?? []).filter((r) => (r.coverage?.covered?.length ?? 0) > 0 || r.score > 0.02);
  if (results.length === 0) process.exit(0);

  const lines = results
    .slice(0, 3)
    .map(
      (r) =>
        `- ${r.name}${r.isDemo ? " [DEMO]" : ""} (${r.slug}): ${r.whyItMatches?.[0] ?? r.summary?.slice(0, 100)}${r.priceFromCents != null ? ` — from $${(r.priceFromCents / 100).toFixed(0)}` : ""}`,
    )
    .join("\n");

  console.log(
    `<amos-marketplace-context>\nCode Recycle already lists software matching this request:\n${lines}\nBefore scaffolding from scratch, consider the search-before-build skill: inspect these with the code-recycle MCP tools and offer the user the customize-instead-of-rebuild option (honest coverage assessment; respect their choice).\n</amos-marketplace-context>`,
  );
} catch {
  // fail open
}
process.exit(0);
