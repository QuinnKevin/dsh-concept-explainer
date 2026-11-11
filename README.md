# Concept explainer

English | [简体中文](README.zh.md)

Select an unfamiliar term in a DeepSeek Harness conversation and get an explanation grounded in the discussion around it, in the right sidebar. The explanation and your follow-ups stay there; the conversation gains, loses, and rewrites nothing.

## Usage

1. Select the term you do not understand — in an assistant answer or in your own prompt.
2. Two equivalent entry points:
   - Click **Explain** in the composer's left tool row. It uses the current selection; with nothing selected it just opens the panel.
   - Or right-click the selection and choose **Explain this**.
3. The right sidebar opens the **Concept explainer** tab, streams the answer, and lists which conversation fragments it used.
4. Keep asking follow-ups at the bottom: Enter sends, Shift+Enter adds a line.
5. **Customize prompt** at the top of the tab edits the system prompt sent to the model. Saved changes apply to later answers; **Restore default** brings back the built-in rules.
6. The tab is also listed in the sidebar's `+` menu; its empty state explains how to start.

## Why the conversation stays untouched

- Requests go to the plugin's own `POST /api/concept-explainer/stream`, which only **reads** the session's messages as context.
- The answer is written into the tab's React state only; no message is appended to the host session log.
- The transcript lives in the panel's memory. Switching tabs keeps it (the tab stays mounted); restarting Harness clears it.
- The panel header always states: "Reads conversation fragments as context only; never writes to the conversation".

## How it is built

| Part | Where | Host API used |
| --- | --- | --- |
| Entry on selected text | `client.js` | `ctx.uiConversation.interactions.register` + the `conversation.chat.text-interaction` seat |
| Composer entry | `client.js` | the `conversation.input.left` seat |
| Right-sidebar tab | `client.js` | `ctx.sidebarRightTabs.register` + `ctx.sidebarRight.openTab` + the `sidebar.right.pane.tab[.title]` seats |
| Explanation | `index.js` | `ctx.connection.fetch.register` + `ctx.llm.stream` (the conversation's model, falling back to the default model) |
| Context | `prompt.js` | `ctx.sessions.get(id).deriveMessages()`, read-only |
| Custom prompt | `client.js` + `index.js` | the browser's `localStorage` holds the user's replacement system prompt and sends it with each request; an empty value falls back to the built-in rules |

`index.js` and `prompt.js` import no Harness package: plain ESM plus the platform's own `Request` / `Response` / `ReadableStream`.

## Install

The package is a plain `dsh.bundle` bundle with no build step. Install it through the Harness Plugin Manager's add-plugin flow, pointing at a local checkout of this directory; it then appears in the right sidebar's tab menu. The client half needs a page reload, a change to the host half needs a full Harness restart.

## Local checks

```powershell
node --check index.js; node --check prompt.js; node --check client.js
node test/host.test.mjs
node test/client.test.mjs
```

`test/host.test.mjs` drives the real request handler with a fake Cordis context: payload validation, the context window, prompt assembly, the NDJSON stream, model failures and follow-up history — and asserts that the session write path is never called. `test/client.test.mjs` captures the browser module with a fake loader and drives `apply` against a recording context: every registration, the interaction admission rules, the prompt editor, and both panel states.

## Known limits

- Only two entry points exist on purpose: the host allows one text interaction at a time, and the built-in "Quote text" bubble already owns the left-selection gesture. Taking it over would replace a shipped feature.
- The custom prompt lives in this browser's `localStorage`. It does not sync across devices and is never written into DSH settings or the session log.
- A custom prompt **replaces** the built-in explanation rules. Conversation fragments are still delivered as read-only context inside the user message, so conversation text is never treated as instructions.
- Explanations render as plain text with line breaks preserved; Markdown code blocks are not rendered.
- No web search or dictionary lookup: the answer comes from the model and the conversation. Unknown concepts are reported as such rather than invented.
