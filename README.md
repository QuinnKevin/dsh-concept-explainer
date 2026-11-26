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
6. **Save** at the top writes the whole panel conversation — explanation, follow-ups and the referenced fragments — as a Markdown note in the workspace. The panel then shows the file name.
7. **Save as session** turns the same conversation into a new session in the left list and opens it, so you can keep talking there.
8. The tab is also listed in the sidebar's `+` menu; its empty state explains how to start.

## Save as a session

When an explanation is worth continuing, **Save as session**:

- forks the current conversation natively, so the branch carries the full history plus everything DSH injects into the context (AGENTS.md instructions, runtime context, system reminders)
- appends the panel's explanation (answer, follow-ups and their answers) as the branch's next exchange
- opens the branch immediately, ready for the next question
- titles it with the concept you selected, truncated when long
- The difference from **Save**: a note is a Markdown file; a session is a real conversation you can continue
- Once saved, the button reads **Saved as session** and cannot save again; the link details live in its tooltip

Once saved, the panel and the branch stay one conversation: a follow-up asked in the panel is appended to the session immediately, and anything typed in that session appears in the panel through its event stream. The panel shows the explanation exchange onward — not the whole forked history.

## Saving a note

A good explanation should not disappear when the tab closes. **Save** writes one Markdown file into the workspace of the conversation the panel belongs to:

- Location: `<workspace>/concept-notes/yyyy-mm-dd-<concept>.md`
- Contents: the explanation, every follow-up question and answer, the referenced conversation fragments, the save time and the source session
- Existing files are never overwritten: a second save in the same day becomes `…-2.md`, then `…-3.md`
- Nothing is written until you press Save; unsaved conversations stay in the panel's memory only
- The note is an ordinary Markdown file, so it shows up in the workspace file tree and can be edited, committed or deleted like any other file

## Why the original conversation stays untouched

- Requests go to the plugin's own `POST /api/concept-explainer/stream`, which only **reads** the session's messages as context.
- Until you branch the panel into a session, the answer is written into the tab's React state only; no message is appended to the original conversation's log.
- The transcript lives in the panel's memory. Switching tabs keeps it (the tab stays mounted); restarting Harness clears it.
- The panel header states which mode it is in: before a branch it reads only, and once linked it says that follow-ups asked here are written into that session.

## How it is built

| Part | Where | Host API used |
| --- | --- | --- |
| Entry on selected text | `client.js` | `ctx.uiConversation.interactions.register` + the `conversation.chat.text-interaction` seat |
| Composer entry | `client.js` | the `conversation.input.left` seat |
| Right-sidebar tab | `client.js` | `ctx.sidebarRightTabs.register` + `ctx.sidebarRight.openTab` + the `sidebar.right.pane.tab[.title]` seats |
| Explanation | `index.js` | `ctx.connection.fetch.register` + `ctx.llm.stream` (the conversation's model, falling back to the default model) |
| Context | `prompt.js` | `ctx.sessions.get(id).deriveMessages()`, read-only |
| Saved note | `index.js` | writes `<session cwd>/concept-notes/*.md` with Node's `fs`; the destination is fixed by the host, never chosen by the request |
| Saved session | `index.js` | `sessionController.fork` copies the conversation (injected context included), then appends the panel's explanation as one turn; the client's `uiWorkspace.openSession` opens it |
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
- A saved note goes to the conversation's workspace only; there is no workspace picker in this version.
- No web search or dictionary lookup: the answer comes from the model and the conversation. Unknown concepts are reported as such rather than invented.

## License

MIT — see [LICENSE](LICENSE).
