# dsh-botmode — DeepSeek Harness 的 Bot 团队模式

给 DeepSeek Harness（dsh）加一个 **Bot 模式**：侧边栏一个切换入口，进入一个独立的 Bot 团队页面。每个 Bot 有自己的目录、人格、记忆、模型绑定、工具白名单和永久会话；Bot 之间可以互相派活；2–6 个 Bot 能进 Group Room 串行开会；Host 侧持久 Routines 能在会话冷却后按 cron 唤醒 Bot。

当前版本：`0.3.0`（Host 编排 + Client 页面双半区均已落地）。

## 它解决什么

Hermes 的 Bot Mode 本质是「一组有身份的 agent + 一个群聊路由状态机 + 一个常驻调度器」。本插件把这三件事分别落到 dsh 的真实能力上：

| 能力 | 实现 |
| --- | --- |
| Bot 身份隔离 | `$DSH_HOME/botmode/bots/<slug>-<id>/` 下的 `bot.json`、`SOUL.md`、`MEMORY.md`、`.dsh/skills/team/SKILL.md`；每个 Bot 独立 `sessionId`、模型、工具策略、审批策略 |
| 永久 Bot Chat | `botId → canonicalSessionId`，Host 通过 `sessionController` 创建/恢复；`/new`、`/reset` 在 Bot 会话里被改写为 compaction，不换会话 |
| 队友消息 | `message_agent` 工具：异步投递，立即返回 `dispatched`；目标忙则每 Bot FIFO；`expectReply` 回复送回发送者；超过 16,000 字符落盘并回路径 |
| Group Room | 2–6 人；`auto`（先显式 @，否则 lead/first）、`everyone`；`[NO_REPLY]` 跳过；`@user` 升级；预算 3 轮 / 10 条后暂停，等人 Continue/Stop |
| 持久 Routines | Host 自己解析五段 cron，`setInterval` 包在 `ctx.effect()` 中；支持冷会话唤醒、手动 `Run now`、暂停/恢复 |
| 审批 | Bot 会话的 approval 请求由 Host 桥接：`once / session / always / deny`，页面顶部出现审批条；未处理 2 分钟自动拒绝 |
| Sections | 分组存于 `state.json`，侧边栏按 Section 分组；Bot 表单可选 Section，可新建 Section |
| 页面入口 | `sidebar.panellist` 图标 + 侧边栏底部 `Bot 模式` 按钮；`main` 面板 key `botmode` |

## 安装

插件是标准 dsh bundle，包名 `@local/dsh-botmode`，通过 profile 的 `dsh.bundle.patch` 插入一行 Host 插件，并带一个 `dsh.client` 前端模块。

```bash
# 在 dsh 里（或桌面端插件管理器中）把本目录作为 bundle 安装
dsh plugin --profile desktop install /Users/a1412/Desktop/dsh-bot/packages/dsh-botmode
```

桌面端也可以直接用 Plugin Manager 的 `install_bundle`，target 传包目录绝对路径。安装后：

- Host 行：`include:botmode`，模块 `@local/dsh-botmode`
- Client 模块：`@local/dsh-botmode/client`
- 状态根：`$DSH_HOME/botmode`

改完代码后，用 Plugin Manager 关闭再打开 `include:botmode` 即可重载 Host；Client 改动刷新页面即可（若在跑 `pnpm run dev:web`，会热更新）。

## 使用

1. 侧边栏点机器人图标，或底部 `Bot 模式`，进入 Bot 页面。
2. `新建` 一个 Bot：名字、角色、常驻指令、分组、模型（provider/model 留空则用默认）、工具白名单、审批策略。
3. 创建后会立刻生成目录与身份文件，并创建一个 canonical Session。
4. 在 Bot 详情里直接聊天；回复按官方轨迹样式渲染：思考过程可折叠、正文 Markdown/代码块、工具调用行可展开参数与输出，流式时有 shimmer 与光标。`定时例程` 区域可以建 cron、立即跑、暂停、删除。
5. 建 Group Room：选 2–6 个 Bot，选路由模式，发一条消息。`@某个Bot` 指定先手；回复里 `@别人` 接力，`@user` 会暂停并标记“需要你”。
6. 需要审批时，页面顶部出现审批条：允许一次 / 本会话允许 / 总是允许 / 拒绝。

## 目录结构

```
packages/dsh-botmode/
  index.js              Host 插件入口：服务、工具、命令、HTTP、approval 桥
  client.js             Client 模块：Bot 页面、侧边栏入口、i18n、CSS
  host/
    store.js            state.json 原子写 + 串行 mutate；Bot 目录管理
    persona.js          SOUL.md / MEMORY.md / TEAM.md / team skill 渲染与落盘
    dispatch.js         每 Bot FIFO、会话恢复、回复提取、16k 截断落盘
    rooms.js            Group Room 状态机（预算、@、NO_REPLY、pause/resume）
    routines.js         持久 cron 调度器（冷会话唤醒）
    cron.js             五段 cron 解析与下一次时间
    approvals.js        Bot 审批桥（once/session/always/deny + 超时）
    api.js              /botmode/api/state + /botmode/api/command
  test/host.test.mjs    Host 逻辑无头测试
  cordis.patch.yml      插入 Host 行
  package.json          dsh.bundle.patch + dsh.client
```

持久状态：

```
$DSH_HOME/botmode/
  state.json                     sections / bots / rooms / routines
  bots/TEAM.md                   团队名册
  bots/roster.json               机器可读名册
  bots/<slug>-<id6>/
    bot.json                     该 Bot 的完整记录
    SOUL.md                      人格与常驻指令
    MEMORY.md                    长期记忆（Bot 可自己改）
    .dsh/skills/team/SKILL.md    如何用 message_agent
```

## Host API

所有请求先过 dsh 的 Connection 同源/登录栅栏；未登录返回 401。

- `GET /botmode/api/state` → roster、sections、rooms（含 transcript/预算/运行态）、routines、approvals、工具名、状态根
- `POST /botmode/api/command`，body `{ type, ... }`

命令：

| type | 参数 | 说明 |
| --- | --- | --- |
| `bot.save` | `botId?`, `draft` | 新建/更新；新建会建目录、建会话、写身份文件 |
| `bot.delete` | `botId` | 删记录、停调度、删目录、重写团队文件 |
| `bot.dispatch` | `botId`, `text` | 入队一条用户消息 |
| `bot.stop` | `botId` | 取消当前 turn |
| `section.save` / `section.delete` | `sectionId?`, `name` | 分组 |
| `room.save` / `room.delete` | `roomId?`, `draft` | Group Room |
| `room.send` / `room.control` | `roomId`, `text` / `action` | 发消息 / `continue` `stop` |
| `routine.save` / `routine.delete` / `routine.toggle` / `routine.run` | 见页面 | 例程 |
| `approval.decide` | `approvalId`, `decision` | `once` `session` `always` `deny` |

## 工具与命令

Host 注册两个全局工具（Bot 会话里可用，非 Bot 会话调用会返回“不是 Bot”）：

- `message_agent({ target, message, expectReply? })`：目标可用名字或 id；返回 `{ok, delivered, queued, target}`。Group Room 回合内禁用。
- `bot_team({ action: roster|me|rooms })`：名册、自己的身份、所在 Room。

人类命令：

```
/botmode status
/botmode roster
/botmode dispatch <bot> <text>
/botmode room <roomId> <text>
/botmode routine <routineId>
/botmode scaffold
```

## 测试

```bash
node packages/dsh-botmode/test/host.test.mjs
```

覆盖：cron 解析、store/身份文件、Dispatcher FIFO 与回复提取、Room 状态机、审批策略、API state/command。

## 边界与已知限制

- `/new`、`/reset` 的压缩依赖当前组合里装了 compaction 引擎；没有引擎时命令会返回明确的失败文本，不会静默换会话。
- Group Room 的 `auto` 是“显式 @ 优先，否则 lead/first”，没有单独的小模型 group_router。
- Bot 的模型/工具变更在**下一次 turn**生效（模型）或**下一次会话恢复**生效（工具/人格 section）。
- 审批条依赖 Bot 页面打开；无人值守时 2 分钟自动拒绝，避免 Routine 卡死。
- 方案 B（子进程隔离）未实现；所有 Bot 共用一个 Host 进程、各自独立会话与目录。
- `lib/` 编译产物未生成，当前直接发 ESM 源码；Node 内置模块 + 相对导入，避免 profile 解析第三方依赖。