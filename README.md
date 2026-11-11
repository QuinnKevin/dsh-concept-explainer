# 概念解释器（Concept explainer）

在 DeepSeek Harness 的对话里选中一个不懂的词句，在右侧栏获得一段结合当前对话语境的解释；解释和追问都留在右侧栏，主对话不新增、不改写任何消息。

## 用法

1. 在主对话里选中不懂的词句（助手回答或你的提问都行）。
2. 两种发起方式，效果一样：
   - 点输入框左侧工具栏的「解释」按钮（会带上当前选中的词句；没选中就只打开面板）；
   - 或者直接在选区上**右键**，点「解释此概念」。
3. 右侧栏自动打开「概念解释」标签，流式给出解释，并标出参考了哪几段对话。
4. 在底部输入框继续追问；Enter 发送，Shift+Enter 换行。
5. 点标签顶部的「自定义要求」，可以改发给模型的系统提示词（解释要求），保存后对之后的回答生效；「恢复默认」回到内置规则。
6. 也可以从右侧栏的 `+` 菜单手动打开「概念解释」标签，里面会提示怎么发起。

## 它是怎么做到“不影响原对话”的

- 解释请求走插件自己的 `POST /api/concept-explainer/stream`，只**读**当前会话的消息作为语境。
- 结果只写进右侧栏这个页面的 React 状态，宿主会话日志里不会多出一条消息。
- 追问记录只存在当前面板内存里；切走再回来（标签保持挂载）仍在，重开 Harness 就没了。
- 面板顶部固定显示「只读取对话片段作为语境，不写入主对话」。

## 实现要点

| 部分 | 位置 | 使用的宿主接口 |
| --- | --- | --- |
| 选中文字后的入口 | `client.js` | `ctx.uiConversation.interactions.register` + `conversation.chat.text-interaction` 座位 |
| 右侧栏标签 | `client.js` | `ctx.sidebarRightTabs.register` + `ctx.sidebarRight.openTab` + `sidebar.right.pane.tab[.title]` 座位 |
| 解释生成 | `index.js` | `ctx.connection.fetch.register` + `ctx.llm.stream`（沿用当前会话的模型；没有就用默认模型） |
| 语境提取 | `prompt.js` | `ctx.sessions.get(id).deriveMessages()`，只读 |
| 自定义提示词 | `client.js` + `index.js` | 浏览器 `localStorage` 存用户改写的系统提示词，随请求发送；宿主留空时回退内置规则 |

`index.js` 与 `prompt.js` 不导入任何 Harness 包，纯 ESM + 平台原生 `Request`/`Response`/`ReadableStream`。

## 本地验证

```powershell
node --check index.js; node --check prompt.js; node --check client.js
node test/host.test.mjs
```

`test/host.test.mjs` 用假的 Cordis 上下文跑真实请求处理链路：参数校验、语境窗口、prompt 组装、NDJSON 流、模型报错、追问历史，并断言处理过程中从不调用会话写入。

## 已知边界

- 首版只支持「右键选中文字」和「输入框左侧按钮」两种发起方式：宿主同一时刻只允许一个文字交互入口，左键选区的气泡已被内置「引用文本」占用，抢占会顶掉原有功能。
- 自定义提示词保存在本机浏览器（`localStorage`），不跨设备同步，也不写进 DSH 的会话或配置。
- 改自定义提示词会完全替换内置解释规则；主对话片段始终以「只读语境」出现在用户消息里，所以替换后仍不会被对话内容当指令执行。
- 解释用纯文本渲染（保留换行），不渲染 Markdown 代码块。
- 不使用第三方搜索/词典，解释完全来自模型与对话语境；模型不认识的概念会直说。
