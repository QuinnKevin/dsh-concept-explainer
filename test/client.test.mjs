/**
 * Browser-half wiring tests.
 *
 * `client.js` is a module-loader artifact, so this file captures its
 * definition with a fake loader, supplies a minimal React stand-in (the real
 * React lives in the page's module table, not in Node), and drives `apply`
 * against a recording context. It cannot prove pixels; it does prove every
 * registration the plugin makes, the interaction admission rules, and that
 * both components render without throwing for the states the panel can show.
 *
 * Run with: node test/client.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** The host's own composer, to pin the editor's text to what is really sent. */
const { composeSystemPrompt } = await import('../prompt.js')

/** Minimal React: only the surface client.js actually uses. */
function makeReact() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  })
  return {
    createElement,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: initial => ({ current: initial }),
    useEffect: () => {},
    useCallback: fn => fn,
  }
}

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(mod) { definition = mod },
  },
}
await import('../client.js')

/** A locale resolver over the plugin's own dictionaries. */
function makeTranslator() {
  const dictionaries = {}
  const bind = ns => (key, params) => {
    const dict = dictionaries[ns]?.['zh'] ?? {}
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
  return {
    dictionaries,
    bind,
    register(ns, dicts) {
      dictionaries[ns] = dicts
      return () => {}
    },
  }
}

/** A recording Cordis context. */
function makeContext() {
  const record = { slots: [], interactions: [], tabs: [], opened: [] }
  const locale = makeTranslator()
  const ctx = {
    locale,
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    slots: {
      inject(name, callback) { return callback() },
      register(registration, Component) {
        record.slots.push({ ...registration, Component })
        return () => {}
      },
    },
    uiConversation: {
      interactions: {
        register(interaction) {
          record.interactions.push(interaction)
          return () => {}
        },
      },
    },
    inject(deps, callback) {
      return callback({
        get(name) {
          if (name !== 'sidebarRightTabs') return undefined
          return {
            register(tab) {
              record.tabs.push(tab)
              return () => {}
            },
          }
        },
      })
    },
    get(name) {
      if (name !== 'sidebarRight') return undefined
      return {
        openTab(kind, options) { record.opened.push({ kind, options }) },
        isExpanded() { return false },
        toggleExpanded() { record.toggled = true },
      }
    },
  }
  return { ctx, record }
}

const module = definition.factory(name => (name === 'react' ? makeReact() : {}))

test('the module declares its name, services and apply', () => {
  assert.equal(module.name, 'concept-explainer')
  assert.deepEqual(module.inject, ['slots', 'locale', 'uiConversation'])
  assert.equal(typeof module.apply, 'function')
})

test('apply registers the tab type, the tab bodies and the selection surface', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)

  assert.equal(record.tabs.length, 1)
  assert.equal(record.tabs[0].id, 'concept-explainer')
  assert.equal(record.tabs[0].kind, 'concept-explainer')
  assert.equal(record.tabs[0].keepMounted, true)
  assert.equal(record.tabs[0].guide.length, 1)
  assert.equal(record.tabs[0].guide[0].id, 'concept-explainer')

  const names = record.slots.map(slot => `${slot.name}#${slot.key ?? slot.id}`)
  assert.deepEqual(names, [
    'conversation.chat.text-interaction#concept-explainer',
    'conversation.input.left#concept-explainer',
    'sidebar.right.pane.tab#concept-explainer',
    'sidebar.right.pane.tab.title#concept-explainer',
  ])
  for (const slot of record.slots) assert.equal(typeof slot.Component, 'function')

  assert.equal(record.interactions.length, 1)
  assert.equal(record.interactions[0].id, 'concept-explainer')
  assert.equal(typeof record.interactions[0].onInteraction, 'function')

  const dictionaries = ctx.locale.dictionaries.conceptExplainer
  assert.ok(dictionaries.zh['explain'])
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
})

test('the interaction only claims a right click that carries selected text', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const interaction = record.interactions[0]

  const makeRequest = (trigger, text) => {
    const calls = { open: 0, prevent: 0 }
    return {
      request: {
        trigger,
        sessionId: 'session-1',
        readText: () => text,
        open() { calls.open += 1 },
        preventDefault() { calls.prevent += 1 },
      },
      calls,
    }
  }

  const rightClick = makeRequest('contextmenu', 'MoE 路由')
  interaction.onInteraction(rightClick.request)
  assert.deepEqual(rightClick.calls, { open: 1, prevent: 1 })

  const leftSelection = makeRequest('selection', 'MoE 路由')
  interaction.onInteraction(leftSelection.request)
  assert.deepEqual(leftSelection.calls, { open: 0, prevent: 0 })

  const empty = makeRequest('contextmenu', '   ')
  interaction.onInteraction(empty.request)
  assert.deepEqual(empty.calls, { open: 0, prevent: 0 })

  const nothing = makeRequest('contextmenu', null)
  interaction.onInteraction(nothing.request)
  assert.deepEqual(nothing.calls, { open: 0, prevent: 0 })
})

test('the selection pill opens the panel with the selected text', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const pill = record.slots.find(slot => slot.name === 'conversation.chat.text-interaction')

  const opened = []
  const cleared = []
  const dismissed = []
  const element = pill.Component({
    sessionId: 'session-7',
    readText: () => '  向量嵌入  ',
    dismiss: () => dismissed.push(true),
    clearSelection: () => cleared.push(true),
    run: (sessionId, text) => opened.push({ sessionId, text }),
    t: text => text,
  })

  assert.equal(element.type, 'button')
  assert.equal(element.props.className, 'dce-pill')
  element.props.onClick()

  assert.deepEqual(opened, [{ sessionId: 'session-7', text: '向量嵌入' }])
  assert.equal(cleared.length, 1)
  assert.equal(dismissed.length, 1)
})

test('the composer tool button stays in the existing row and opens the panel', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const tool = record.slots.find(slot => slot.name === 'conversation.input.left')

  const opened = []
  const element = tool.Component({
    sessionId: 'session-1',
    open: (sessionId, text) => opened.push({ sessionId, text }),
    label: '解释',
    hint: '解释此概念',
  })

  assert.equal(element.type, 'button')
  assert.equal(element.props.className, 'dce-tool')
  assert.equal(element.props.title, '解释此概念')
  assert.equal(element.props.children[1].props.children, '解释')
  element.props.onClick()
  // No browser selection in Node: the click still opens the panel empty state.
  assert.deepEqual(opened, [{ sessionId: 'session-1', text: '' }])
})

test('the composer tool button leaves no dock row behind', () => {
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  assert.equal(source.includes('conversation.composer.dock'), false)
  assert.equal(source.includes('dce-dock'), false)
})

test('the prompt editor shows exactly the host default prompt', () => {
  assert.equal(module.defaultSystem, composeSystemPrompt())
})

test('the prompt storage round-trips and clears', () => {
  const store = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
    },
  })
  assert.equal(module.promptStorage.read(), '')
  assert.equal(module.promptStorage.write('用英文回答，先给一句类比。'), true)
  assert.equal(module.promptStorage.read(), '用英文回答，先给一句类比。')
  module.promptStorage.write('')
  assert.equal(module.promptStorage.read(), '')
})

test('the prompt editor renders one textarea and three actions', () => {
  const element = module.PromptEditor({
    t: key => key,
    value: '用英文回答',
    onChange: () => {},
    onSave: () => {},
    onCancel: () => {},
    onRestore: () => {},
  })
  const json = JSON.stringify(element)
  assert.match(json, /dce-editor-input/u)
  assert.match(json, /settingsTitle/u)
  assert.match(json, /settingsHint/u)
  assert.match(json, /restore/u)
  assert.match(json, /save/u)
})

test('the panel renders the empty state before a concept is chosen', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const panel = record.slots.find(slot => slot.name === 'sidebar.right.pane.tab')

  const element = panel.Component({
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { navigation: { address: 'page:concept-explainer', params: {}, revision: 0 } } }),
    t: text => text,
  })
  assert.equal(element.type, 'div')
  assert.equal(element.props.className, 'dce-panel')
  const rendered = JSON.stringify(element)
  assert.match(rendered, /dce-empty/u)
  assert.match(rendered, /emptyHint/u)
  assert.match(rendered, /readOnly/u)
})

test('the panel renders a concept header and composer from tab navigation params', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const panel = record.slots.find(slot => slot.name === 'sidebar.right.pane.tab')

  const element = panel.Component({
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { navigation: { address: 'page:concept-explainer', params: { concept: 'MoE 路由', nonce: 'n1' }, revision: 3 } } }),
    t: text => text,
  })
  const rendered = JSON.stringify(element)
  assert.match(rendered, /MoE 路由/u)
  assert.match(rendered, /dce-compose/u)
  assert.match(rendered, /dce-input/u)
})

test('the panel also accepts a navigation store instead of a snapshot', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const panel = record.slots.find(slot => slot.name === 'sidebar.right.pane.tab')
  const element = panel.Component({
    sessionId: 'session-1',
    useTabInfo: () => ({
      tab: {
        navigation: {
          getSnapshot: () => ({ address: 'page:concept-explainer', params: { concept: 'RAG' }, revision: 1 }),
        },
      },
    }),
    t: text => text,
  })
  assert.match(JSON.stringify(element), /RAG/u)
})

test('the tab chip renders a title', () => {
  const { ctx, record } = makeContext()
  module.apply(ctx)
  const title = record.slots.find(slot => slot.name === 'sidebar.right.pane.tab.title')
  const element = title.Component({ t: key => (key === 'tabTitle' ? 'Concept explainer' : key) })
  assert.deepEqual(element.props.children, 'Concept explainer')
})

test('the stylesheet only references host theme tokens', () => {
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  const colors = source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? []
  assert.deepEqual(colors, [], `literal colors must come from theme tokens: ${colors.join(', ')}`)
  assert.match(source, /--dsw-alias-label-primary/u)
  assert.match(source, /--dsw-specific-sidebar-fill/u)
})
