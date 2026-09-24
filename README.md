# OpenRouter Ensemble Chat Provider

A VS Code extension built on the stable **Language Model Chat Provider API** (VS Code ≥ 1.104) that plugs
[OpenRouter](https://openrouter.ai) into GitHub Copilot Chat — including **virtual ensemble models** where
N LLMs work together on every request.

```
Copilot Chat / Agent Mode  ──►  "Ensemble: Fast (MoA)"   (one model in the picker)
                                   │
                ┌──────────────────┼──────────────────┐   parallel, via OpenRouter
                ▼                  ▼                  ▼
   ~gemini-flash-latest  ~deepseek-flash-latest  ~glm-flash-latest  ~gpt-luna-latest   ← proposers (drafts)
                └──────────────────┼──────────────────┘
                                   ▼   (council: anonymous peer ranking, Borda count)
                     ~anthropic/claude-sonnet-latest                ← aggregator
                   streams the final answer + performs tool calls
```

## Features

**Three kinds of models in the picker**

- **Single models**: any OpenRouter model 1:1, with per-model reasoning effort and fallbacks.
- **Ensembles**: N drafting models work in parallel; a final model writes the answer and runs tools.
- **Routers ("Auto")**: each message is rated by difficulty and sent to a cheap model, a strong model, or an ensemble.

**Ensemble strategies** (composable stages)

| Strategy | Stages | Based on |
| --- | --- | --- |
| Mixture of agents | drafts → final | Together MoA (Wang et al. 2024) |
| Council | drafts → peer review (rubric, own drafts excluded) → final | Karpathy llm-council, amiable llm-council |
| Judge | drafts → one judge scores all → final | OptiLLM GenSelect |
| Plan & build | plans (observations, approach, risks, verification) → final merges and executes with tools | PlanSearch, CePO |

Optional per ensemble: **revise** (second MoA layer), **critique** before answering (OptiLLM MoA),
**re-read** (RE2), perspectives per drafting model, same model several times with an automatic
temperature ladder (Self-MoA, MARS), reasoning effort per role.

**Quality details**

- Peer reviews use a correctness-weighted rubric with an accuracy ceiling, so a well-written wrong draft can't win.
- Reviewers never score their own model's drafts (self-preference bias); drafts are anonymized and shuffled per reviewer.
- Reviewer issues and low reviewer agreement are passed to the final model; drafts are XML-sandboxed against prompt injection.

**Drafts that see the code (`trigger: "afterExploration"`)**

By default drafts start with the user's message and only see the conversation. With *afterExploration*
the final model first gathers context with **read-only tools only** (VS Code memory, reading files, search),
then calls an internal `request_expert_drafts` tool when it has enough. The drafting models get the
conversation including everything read so far; the final model then continues with the full toolset in the
same response. Editing before the drafts is impossible, the handoff call never reaches VS Code, simple
questions are answered directly without drafts, and `maxExplorationSteps` caps the reading phase.
Tools are classified by the verbs in their names; write verbs win, and unknown tools are hidden during
exploration. Set the log level to *Debug* to see which tools arrive and how they were classified.

**Performance memory**

For every message an ensemble handles, the extension records per drafting model: delivered / failed /
cancelled by the grace period, latency, cost, review score and win (council, judge), and how much of the
final answer (text plus edit arguments) matches its draft (word 3-gram attribution, no LLM call).
The settings page shows this per ensemble with a verdict (strong, fair, weak, slow, unreliable) relative to
each model's fair share, and offers to remove weak models. Verdicts start after 10 messages per model.
Only numbers and model ids are stored (VS Code `globalState`); prompts, drafts and code never are.

**Speed and cost**

- Quorum + grace period: once enough drafts are in, stragglers get a few seconds and are then cancelled.
- Tool steps of one message reuse all stages (drafts, reviews, critique) and stay on the router's chosen target.
- Sticky sessions (`session_id`) keep a conversation on one provider for prompt-cache hits; the log shows cached tokens.
- Reasoning effort is mapped to the nearest level each model supports; unsupported parameters are never sent.
- Router: free heuristics for obvious cases, a small classifier for the rest (switchboard-style blend). It escalates when a target can't call tools or read images.

## Sidebar

The OpenRouter Ensemble icon in the activity bar opens a usage dashboard:

- **Totals**: this key's spend today, this week and this month, plus the key's limit (or your account balance with a management key).
- **Now**: what's running, live: the router's decision, the current phase (reading the code, drafting, reviewing, answering), each draft's state (writing, done, too slow, failed) and the cost so far.
- **Spend chart**: stacked bars per day and model for 7 or 30 days, with a per-day breakdown on hover. Two sources:
  - *This extension*: every call it made, recorded locally, including today.
  - *Account*: your whole OpenRouter account from `/activity` (needs an optional **management key**; covers completed UTC days, today comes from the key's running total).
- **Breakdown** by model, by ensemble/router, or by stage (final answer, drafts, reviews, exploring, router rating), with each row's share of the spend and the share of cached prompt tokens.
- **Recent calls** with stage, source, tokens and cache hits.

Every OpenRouter call reports its usage centrally with its stage and source, so nothing is missed. The local
ledger keeps daily totals for 90 days; it stores numbers and model ids only.

## Settings page

Chat model picker → **Manage Models…** → **OpenRouter Ensemble**, or run **OpenRouter Ensemble: Open Settings**.

- **Connection**: add, replace or remove the API key. Keys are verified against OpenRouter before they're stored; shows usage and credit limit.
- **Models**: search the live OpenRouter catalog (context size, price per 1M tokens) and tick models for the picker.
- **Ensembles**: create and edit ensembles with a live flow diagram, calls-per-message and combined price, plus warnings for unknown models or a final model without tool calling.
- **Advanced**: draft timeout, transcript length, usage logging, extra request JSON (validated).

Changes are written to your user settings (`Ctrl/Cmd+S` saves). If a workspace overrides a setting, the page tells you.

## Defaults use auto-updating aliases

All defaults use OpenRouter's `~vendor/…-latest` aliases (e.g. `~anthropic/claude-sonnet-latest`, `~openai/gpt-sol-latest`), which always point to the newest model of that line, so the ensembles don't go stale. `:batch` variants are hidden because they only work with OpenRouter's batch API.

## Setup

```bash
npm install
npm run compile
# F5 → Extension Development Host
npm run package   # → .vsix
```

1. Chat view → model picker → **Manage Models…** → **OpenRouter Ensemble** → the settings page opens; add your `sk-or-…` key.
2. Enable the models/ensembles you want in the picker.
3. Configure ensembles on the settings page, or directly in `settings.json`:

```jsonc
"openrouterEnsemble.ensembles": [
  {
    "id": "review-council",
    "name": "Ensemble: Code Review Council",
    "strategy": "council",
    "proposers": ["~openai/gpt-sol-latest", "~x-ai/grok-latest", "~deepseek/deepseek-pro-latest"],
    "aggregator": "~anthropic/claude-opus-latest",
    "proposerMaxTokens": 4096,
    "trigger": "userTurns"
  }
],
"openrouterEnsemble.models": ["~anthropic/claude-sonnet-latest", "~openai/gpt-sol-latest"],
"openrouterEnsemble.extraBody": { "provider": { "data_collection": "deny" } }
```

## OpenRouter API types

The client uses plain `fetch` (no runtime dependencies), but all request/response types are generated from
OpenRouter's public OpenAPI spec — the same source the official `@openrouter/sdk` is generated from:

```bash
npm run gen:types   # fetches https://openrouter.ai/openapi.json → src/generated/openrouter-api.d.ts
```

The generated file is imported with `import type` only, so it adds nothing to the extension bundle.
Re-run it when OpenRouter ships API changes; the compiler then shows what needs to be adapted.

## What was deliberately left out

- **Cascades** (answer cheap, judge, escalate; FrugalGPT / switchboard `router-cost`): they need the full answer before the user sees anything, which breaks streaming and tool calls in agent mode. The router decides up front instead.
- **Logit-based techniques** (CoT decoding, entropy decoding, DeepConf, AutoThink): not possible through a hosted API. Reasoning effort covers the Thinkdeeper use case.
- **MCTS, R\*, PV Game, full CePO/MARS**: 20-60 calls per request, tuned for math benchmarks. Their useful ideas (planning, temperature diversity, effort per role, verification) are in the stages above.

## Notes

- Copilot Business/Enterprise admins can disable models from this API via the *Bring Your Own Language Model Key* policy.
- Cost: an ensemble request costs roughly (N proposers + aggregator), council adds N short ranking calls. Check the log.
- Token counting is a `chars / 4` estimate.

## Project layout

| File | Purpose |
| --- | --- |
| `src/extension.ts` | Activation, commands, `managementCommand` |
| `src/provider.ts` | `LanguageModelChatProvider` implementation, dispatch (single / ensemble / router) |
| `src/pipeline.ts` | Ensemble stages: propose (quorum), refine, council, judge, critique |
| `src/router.ts` | Difficulty triage and tier routing |
| `src/tools.ts` | Tool classification and the exploration handoff tool |
| `src/performance.ts` | Local performance memory, attribution, verdicts |
| `src/usage.ts` | Usage ledger (daily buckets, recent calls) and live activity bus |
| `src/sidebar.ts`, `media/sidebar.*` | Activity-bar dashboard (webview view) |
| `src/registry.ts` | Model capabilities, reasoning mapping, fallbacks, sticky sessions |
| `src/config.ts` | Settings model and defaults |
| `src/prompts.ts` | All stage prompts |
| `src/settingsPanel.ts` | Settings webview (extension side, message handling, CSP) |
| `media/settings.js`, `media/settings.css` | Settings webview UI (vanilla JS, VS Code theme tokens) |
| `src/openrouter.ts` | OpenRouter client (SSE streaming, tool-call accumulation) |
| `src/convert.ts` | VS Code ⇄ OpenAI message conversion, transcript flattening |
| `src/generated/openrouter-api.d.ts` | Generated OpenRouter API types (do not edit) |
| `scripts/gen-types.mjs` | Type generator (OpenAPI → TypeScript) |

MIT License
