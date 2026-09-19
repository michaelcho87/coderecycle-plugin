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
- **Hook** (optional, deterministic): on build-shaped prompts, pre-fetches top marketplace
  matches into context via the free public search API. Fails open; ~1k tokens vs the
  100k+ of re-plumbing.

## Install

```bash
claude plugin marketplace add michaelcho87/coderecycle-plugin
claude plugin install code-recycle
```

(Developing against a local checkout instead: `claude plugin marketplace add /path/to/ai-marketplace-os` — the monorepo root has a marketplace.json too.)

Environment (optional): `AMOS_BASE_URL` (defaults to `https://coderecycle.ai/api/v1`),
`AMOS_API_KEY` (an agent key from Settings → Agents; without it search still works,
purchasing does not).

## Rebuild the bundled server after changes

```bash
pnpm --filter @amos/mcp-remote bundle
```
