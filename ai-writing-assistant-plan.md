# AI Writing Assistant Agent — Implementation Plan

Status: **Approved, ready to implement**
Scope: In-app AI writing assistant for the novel-reader app with an Observe-Think-Act (ReAct-style) agent loop.
Repo plan precedent: this file mirrors `project-binary-plan.md`.

---

## 1. Goals

- A writing partner that operates as a **multi-step agent loop**, not a single-response chatbot: it observes context, thinks, calls tools to load more context, and iterates until it produces a final draft.
- Prompts can be: outlines, random thoughts/paragraphs, continuation requests, or edits to a text selection.
- An **in-topic prompt guard** halts the whole pipeline at the start if the request is out of topic.
- The agent can follow a **chain-of-context** through codex mentions (`#### Codex Mentioned` / `Chapters Mentioned`) instead of only reading the chapter in front of it.
- Writing quality is steered by bundled humanizer + anti-AI-slop rules in the system prompt.
- Auth/providers are user-configurable; nothing AI-related works until the user configures a provider.

Non-goals: auto-save into the editor, background agents, multi-user collaboration.

---

## 2. User Decisions (locked)

| Topic | Decision |
|---|---|
| Assistant location | In-app, in a **new right-side panel** |
| Rules source | Latest `blader/humanizer` (v2.9.0, MIT) + `jalaalrd/anti-ai-slop-writing` (MIT), fetched from GitHub and **bundled in the codebase**; part of the system prompt. Do **NOT** use `WRITING-RULE.txt` (user: unrelated to this project) |
| Guard mechanism | **Hybrid**: local heuristic fast-path + LLM rubric for ambiguous prompts |
| Guard failure | **Fail-open with notice** ("guard skipped") |
| In-topic definition | **Project-scoped**: anything about the story/characters/writing process is in-topic; only genuinely unrelated subjects halt |
| Auth UX | **Provider choice in settings** (ChatGPT device flow / AgentRouter / opencode / custom key+base URL); show a "Configure AI first" state before any AI use |
| Agent output | **Staged draft in the panel**; explicit "Insert" button moves it into the editor (append at chapter end / replace selection) |
| Agent shape | Multi-step **Observe-Think-Act loop** (GENERATE → PARSE → EXECUTE → RESUME), max 12 iterations |

---

## 3. Pipeline Overview

```
user prompt (+ selection / manual refs)
      │
      ▼
[1] detectIntent + assembleContext (light anchor, cheap, no LLM)
      │
      ▼
[2] PROMPT GUARD  ───────────────►  HALT + reason shown in panel
      │  (heuristic fast-path,        (no tools, no chain)
      │   LLM rubric if ambiguous,
      │   fail-open with notice)
      ▼
[3] AGENT LOOP (browser-side)
      GENERATE ──► PARSE ──► EXECUTE ──► RESUME  (↺ until done)
      │   tools: load chapters/codex, search, mentions, draft, finalize
      ▼
[4] finalize() → staged draft in right panel
      │
      ▼
[5] user reviews → Insert (append at chapter end / replace selection)
```

---

## 4. Phase 1 — Bundled Writing Rules

- Fetch `https://github.com/blader/humanizer` (latest, v2.9.0) → `src/assistant/rules/humanizer.md`
- Fetch `https://github.com/jalaalrd/anti-ai-slop-writing` (MIT) → `src/assistant/rules/anti-ai-slop.md` + `src/assistant/rules/banned-words.md`
- `src/assistant/writingRules.js` composes the system prompt:
  - light-novel writer role + project facts (title, codex names)
  - humanizer rules
  - anti-slop rules + banned words list
  - **agent-loop operating instructions**: "Call tools before writing; observe results; if context is thin, follow the mention chain; never fabricate codex entries; end with `finalize`."
- The composed prompt is exported for reuse in the guard rubric, loop system prompt, and tests.

## 5. Phase 2 — Context Assembly (`src/assistant/context.js`)

Pure functions, no LLM, no I/O beyond the open ProjectDb.

- `detectIntent({ prompt, selection, manualRefs })` → `"continuation" | "selection" | "manual"`
- `assembleContext(...)` → anchor + initial working set:
  - `continuation` → latest chapter (anchor only)
  - `selection` → entire chapter containing the selection + the selected excerpt
  - `manual` → explicit references from the UI picker
  - codex flags respected: `doNotTrack` / `noAutoInclude` / `alwaysIncludeInContext`
- Output: `{ anchorChapter, selection, codexEntries, chain }`
- Deliberately **light**: the loop does not pre-load everything; the tools in Phase 3 expose the rest so the agent decides what to load (avoids context bloat).

## 6. Phase 2b — Prompt Guard (`src/assistant/guard.js`)

Runs once per submission, **before any loop iteration / tool call / LLM proxy request**.

### Stage 1 — Local heuristic (instant, zero LLM)
- Prompt hits a chapter title, character name, codex entry name/alias, or story keyword → **PASS** (skip LLM entirely).
- No overlap at all + clearly unrelated content (e.g. coding, recipes, other stories) → **HALT** with reason.
- Otherwise → Stage 2.

### Stage 2 — LLM rubric (one small call)
- Inputs: project title, codex entry names + aliases, chapter titles, detected mode, raw prompt. **No chapter/codex bodies** (fast + private).
- Strict JSON verdict: `{ "verdict": "in_topic" | "out_of_topic", "reason": "..." }`
- `temperature: 0`, `max_tokens ≈ 60`, same provider/proxy as the writer model.
- `out_of_topic` → **HALT** immediately: zero tool calls, zero chain; the panel shows the reason. Only the guard's own ~60-token request ever leaves the app for rejected prompts.

### Rubric (project-scoped, permissive on form)
- IN: outlines, half-formed thoughts, scene beats, character musings, worldbuilding, "is this a good beat?" meta-questions — anything tied to the story.
- OUT: unrelated subjects (coding, recipes, other stories' characters, general chat, homework, etc.).

### Failure mode
- Guard LLM errors/timeouts/no-auth → **fail-open**: proceed into the loop with a "guard skipped" notice in the panel.

## 7. Phase 3 — Tool Registry (`src/assistant/tools.js`) — the "Act" layer

All tools execute against the browser's in-memory ProjectDb (sql.js). Each tool: name, description, JSON schema for args, timeout, error → observation (loop survives tool failures). Dispatcher validates args and formats observations.

| Tool | Purpose |
|---|---|
| `load_latest_chapter` | continuation anchor |
| `load_chapter(chapterId)` | entire chapter (selection mode) |
| `load_codex_entry(entryId)` | entry body + aliases + tags |
| `get_mentioned_codex(entryId)` | **chain-of-context hop 1** (`#### Codex Mentioned`) |
| `get_chapters_mentioned(entryId)` | **chain-of-context hop 2** (`Chapters Mentioned`) |
| `search_scenes(query)` | find context when the chapter is thin |
| `search_codex(query)` | find codex entries |
| `draft_scene(sceneId, prose)` | stage a draft (no editor write) |
| `finalize(prose)` | emit final result, signal loop stop |

## 8. Phase 4 — Loop Driver (`src/assistant/agentLoop.js`) — the "Think" layer

Browser-side agent runtime (the browser opens `.novel` files locally; only assembled prompts/tool observations are sent through the local proxy).

- Loop spine (ReAct / GENERATE–PARSE–EXECUTE–RESUME):
  1. **GENERATE** — streamed LLM call with `messages + tools`; collect text deltas + `tool_use` blocks.
  2. **PARSE** — extract tool name + args, validate against JSON schema.
  3. **EXECUTE** — run tool against ProjectDb → observation; append to transcript.
  4. **RESUME** — call the model again with the observation appended.
  - Stop on: `finalize` / model `end_turn` / max iterations (12) / token budget / user abort.
- Guards inside the loop: same tool + same args twice → halt (loop detection); tool errors → observation, not crash.
- Token budget + context truncation when the transcript grows.
- Lifecycle events for the UI: `thought`, `tool_started`, `tool_completed`, `text_delta`, `iteration`, `done`, `error`.
- `abort()` via AbortController (user "Stop" button).
- Mid-loop topic drift is bounded by the tool allowlist (tools only touch project data) — no guard needed inside the loop.

## 9. Phase 5 — Auth + LLM Proxy (`server/aiRouter.js`)

Browser cannot read filesystem auth → the local Express server (`127.0.0.1:3001`) owns auth and proxies LLM calls. Tokens never reach the browser.

- Endpoints:
  - `GET /api/ai/status` — provider availability + sign-in state (feeds the "Configure AI first" gate)
  - `POST /api/ai/signin` — provider-specific sign-in (see below)
  - `POST /api/ai/chat` — SSE streaming proxy for `messages + tools` (guard calls + loop calls)
- Providers (user chooses in settings):
  - **ChatGPT** — device-code OAuth flow (same as `codex login`): verification URI + user code shown in the popup, poll until approved, tokens stored server-side. Reuses/validates an existing `~/.codex/auth.json` session when present.
  - **AgentRouter** — `https://agentrouter.org/`, key from console (OpenAI/Anthropic-compatible).
  - **opencode** — reuse `~/.local/share/opencode/auth.json` provider session.
  - **Custom API key** — key + base URL entered manually.
- **Configuration gate:** the AI Writer panel shows a "Configure AI first" state (with a link to settings) until a provider is selected and `/api/ai/status` confirms valid auth. No prompt window, no guard, no loop until configured.
- Privacy note: prompt content passes through the local proxy to the chosen provider — explicit user choice; that is the feature's purpose.

## 10. Phase 6 — UI (`src/main.jsx` + `src/styles.css`)

New **right-side AI Writer panel** (new layout element; reuse existing styles/patterns per AGENTS.md — read `src/styles.css` and `src/main.jsx` first).

- Panel states:
  1. **Not configured** — "Configure AI first" + button to open settings.
  2. **Ready** — prompt textarea (outline / random thoughts / continuation), manual reference picker, detected mode indicator (continuation / selection / manual), selection banner when editor text is selected.
  3. **Guard result** — halt reason or "guard skipped" notice.
  4. **Running** — live transcript: thoughts, tool calls with loaded-context badges, streaming text, iteration counter, **Stop** button.
  5. **Staged draft** — final prose + **Insert** button (append at chapter end / replace selection).
- Settings popup: provider choice (ChatGPT sign-in button with device-code display / AgentRouter key / opencode / custom key+base URL), status line from `/api/ai/status`.

## 11. Phase 7 — Tests

- Guard: heuristic pass/halt/ambiguous routing; rubric verdict handling; fail-open on guard error.
- Context: `detectIntent` all three modes; `assembleContext` selection/continuation/manual; codex flags (`doNotTrack` / `noAutoInclude` / `alwaysIncludeInContext`).
- Loop: multi-step behavior with a **mock tool** + **mock LLM responder** (tool_use → execute → observe → finalize); max-iteration cap; loop detection; tool-error survival; abort.
- Rules: system-prompt composition sanity.
- Verification: `npm test` (35 existing tests stay green) + `npm run build`.

---

## 12. File Map

```
src/assistant/
  rules/          humanizer.md, anti-ai-slop.md, banned-words.md   (bundled, from GitHub)
  writingRules.js system-prompt composition
  context.js      detectIntent + assembleContext
  guard.js        hybrid prompt guard (heuristic + LLM rubric)
  tools.js        tool registry (ProjectDb-backed)
  agentLoop.js    GENERATE→PARSE→EXECUTE→RESUME driver
server/
  aiRouter.js     auth (provider choice) + SSE LLM proxy
src/
  main.jsx        right AI Writer panel, settings popup, selection detection
  styles.css      panel styles (existing patterns)
```

## 13. Implementation Order

1. Phases 1–2: bundle rules, context assembly (+ tests)
2. Phase 2b: prompt guard (+ tests)
3. Phases 3–4: tools + loop driver with mock LLM (+ tests)
4. Phase 5: server auth + proxy
5. Phase 6: right panel UI wiring
6. Phase 7: full test pass + build, manual verification in Chromium

## 14. References

- https://github.com/blader/humanizer (MIT)
- https://github.com/jalaalrd/anti-ai-slop-writing (MIT)
- https://docs.agentrouter.org/en/ · https://agentrouter.org/
- `~/.codex/auth.json` · `~/.local/share/opencode/auth.json`
- Existing humanizer copy (user, v2.2.0): `C:\Users\Hameng\Documents\Story\humanizer.md` (inspiration only; bundle the latest)
