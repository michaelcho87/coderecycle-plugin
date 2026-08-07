# Code Recycle — Claude Code plugin

Stop paying twice for the same plumbing. This plugin makes Claude Code check the
marketplace **before** scaffolding a new app, and customize purchased source within its
license instead of rebuilding.

## What's inside

- **MCP server** (`servers/amos-mcp.mjs`, self-contained bundle): 17 tools — search,
  inspect, compare, plan_solution, quote, policy-governed purchase, entitlements,
  invocation, updates, and `export_customization_context`.
- **Skill** `search-before-build`: fires on build-shaped requests; searches first, does an
  honest coverage assessment (≥60% → recommend customize), respects the user's choice.
- **Offline index** (`index/catalog-index.json`) + **local matcher** (`lib/local-match.mjs`):
  a 264-entry index consulted **locally, for zero tokens, with no network call and no API
  key**. Most questions an agent could ask this catalogue have the answer "no", and paying a
  round-trip to be told "no" is the worst trade in the system — so the network is not the
  front door, this is. Only a hit justifies spending anything.
- **Hook** `plan-aware-match` (PreToolUse on `TodoWrite`/`Write`/`Edit`): watches the plan an
  agent is actually forming and speaks only on a strong local match — at most 3 times per
  session, and never blocking a tool call. Runs against the offline index, so it works with
  no credentials and no connectivity.
- **Hook** `search-before-build` (optional, UserPromptSubmit): on build-shaped prompts,
  pre-fetches top matches via the public search API. Fails open.

## Install

```bash
claude plugin marketplace add michaelcho87/coderecycle-plugin
claude plugin install code-recycle
```

(Developing against a local checkout instead: `claude plugin marketplace add /path/to/ai-marketplace-os` — the monorepo root has a marketplace.json too.)

**No configuration is required for local matching.** The offline index and the
`plan-aware-match` hook work immediately after install, with no key and no network.

Environment (optional): `AMOS_BASE_URL` (defaults to `https://coderecycle.ai/api/v1`),
`AMOS_API_KEY` (an agent key from Settings → Agents; without it search still works,
purchasing does not).

### While the store is closed

`coderecycle.ai` is currently returning `503 — temporarily closed while we build`, so the
remote path (the MCP server and the `search-before-build` hook) will find nothing and fail
open. The **offline index and local matcher are unaffected** and are the reason this plugin
is worth installing today. `index/catalog-index.json` carries a `generatedAt` timestamp so
you can always tell how current your copy is without asking the network.

## Rebuild the bundled server after changes

```bash
pnpm --filter @amos/mcp-remote bundle
```
