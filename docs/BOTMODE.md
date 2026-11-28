# Bot 模式实现细则（dsh-botmode / dsh-quay-bot）

> 本文件是 Bot 模式插件的完整实现说明：Host API、命令表、持久状态、目录结构与测试覆盖。
> 项目总览、安装与架构见 [README.md](../README.md)；虚拟屏子系统见 [BOTSCREEN.md](../BOTSCREEN.md)。

给 DeepSeek Harness（dsh）加一个 **Bot 模式**：侧边栏一个切换入口，进入一个独立的 Bot 团队页面。每个 Bot 有自己的目录、人格、记忆、模型绑定、工具白名单和永久会话；Bot 之间可以互相派活；2–6 个 Bot 能进 Group Room 并行协作直到任务完成；Host 侧持久 Routines 能在会话冷却后按 cron 唤醒 Bot。

当前版本：`0.7.4`（本地开发包 `@local/dsh-botmode`，公开发布包 `dsh-quay-bot` 为 `1.0.1`，同一套源码）。Host 编排 + Client 页面双半区均已落地：Hermes 底座 + 终态驱动全异步 Actor 并发群聊 + 异常探针软暂停 + 共享任务板与路径软锁 + 可插拔全局 Memory Hub 内置 `memory_tencentdb` + Bot 单独绑定模型、思考档位与视觉能力。

v0.7.x 追加模块速查：

| 模块 | 职责 |
| --- | --- |
| `host/isolation.js` | Harness 模式与 Bot 模式的五道边界：提示词、工具、Skills、MCP、会话/UI 隔离 |
| `host/mcp.js` | Bot 侧 MCP 注册表（`$DSH_HOME/botmode/mcp.json`）与两模式优先级协调 |
| `host/channels.js` | 外部事件触发（入站 Webhook）与主动通知（飞书 / 企微 / 钉钉 / Slack / 通用 Webhook） |
| `host/artifacts.js` | 回复产物抽取、安全文件名/MIME、工作区内交付物解析与打包 |
| `host/avatar.js` | 19 款形象目录、12 套黏土色板、12 字段形象偏好校验与随机分配 |
| `host/screen.js` | BotScreen 宿主桥：动态建屏、Agent Token 缓存、423 求助挂起、管理面代理 |
| `host/remote.js` | Remote 入口：`dsh-remote` 网关联动、二维码、密钥轮换 |
| `host/qr.js` | 零依赖 QR 编码器（SVG / data URL） |
| `host/scheduler/*` | 定时任务服务化：调度、执行、投递、运行记录 |

## 它解决什么

Hermes 的 Bot Mode 本质是「一组有身份的 agent + 一个群聊确定性状态机 + 一个可插拔记忆库 + 一个常驻调度器」。本插件把这四件事分别落到 dsh 的真实能力上：

| 能力 | 实现 |
| --- | --- |
| Bot 身份隔离 | `$DSH_HOME/botmode/bots/<slug>-<id>/` 下的 `bot.json`、`SOUL.md`、`MEMORY.md`、`.dsh/skills/team/SKILL.md`；每个 Bot 独立 `sessionId`、模型、工具策略、审批策略 |
| 永久 Bot Chat | `botId → canonicalSessionId`，Host 通过 `sessionController` 创建/恢复；`/new`、`/reset` 在 Bot 会话里触发 `onPreCompress` 记忆检查点后做 compaction，不换会话 |
| 队友消息 | `message_agent` 工具：会话级 FIFO、跳数护栏（默认 4 跳）、同链去重、回信降级、目标歧义拒绝、`expectReply` 回送、超 16k 落盘；群聊隐藏会话严格禁止 |
| Group Room | 2–6 人；独立隐藏 Group Session + 可选共享工程目录 `workDir`；全异步 `BotActor` 并发总线 + 快照水位线防漏看；`completed`（`room_finish_task` 显式终态）/ `settled`（全员 `(pass)` 自然收敛）/ `waiting_user`（`@user` 与局部审批/提问挂起）；空转 `idle_spin`、单 Bot 重复报错 `paused_error`、软 Token 预算 `token_budget` 三大探针兜底；`claim_subtask` 任务板与文件写入软锁；前端底部按 `botId` 分轨流式渲染 + `seq` 到达序固化；Soft Steer 软插话与 `stop` 强杀 |
| 团队记忆库（Memory Hub） | 所有 Bot 共用一套可插拔记忆库插件，按 `team_id` / `agent_id (= bot.id)` / `user_id` 隔离；默认内置 `memory_tencentdb`（对接 v3 Gateway `8420` + 熔断 + 本地 SQLite FTS5 自动降级），另内置 `local_sqlite` 与 `builtin`；支持通过目录、npm、Git、tarball 或本地目录下载/安装/切换/卸载其他记忆库插件 |
| 持久 Routines | Host 自己解析五段 cron，`setInterval` 包在 `ctx.effect()` 中；支持冷会话唤醒、手动 `Run now`、暂停/恢复 |
| 审批 | Bot 私聊与隐藏群聊会话的 `approval/request`（`once / session / always / deny`）及 `ask_user_question`（`user-questions/request`）均由 Host 桥接；群聊会话局部挂起不超时误杀，私聊无人值守 2 分钟自动拒绝 |
| Sections | 分组存于 `state.json`，侧边栏按 Section 分组；Bot 表单可选 Section，可新建 Section |
| 页面入口 | `sidebar.panellist` 图标 + 侧边栏底部 `Bot 模式` 按钮；`main` 面板 key `botmode` |

## 安装

插件是标准 dsh bundle，包名 `@local/dsh-botmode`，通过 profile 的 `dsh.bundle.patch` 插入一行 Host 插件，并带一个 `dsh.client` 前端模块。

```bash
# 在 dsh 里（或桌面端插件管理器中）把本目录作为 bundle 安装
dsh plugin --profile desktop install /path/to/dsh-bot/packages/dsh-botmode
```

桌面端也可以直接用 Plugin Manager 的 `install_bundle`，target 传包目录绝对路径。安装后：

- Host 行：`include:botmode`，模块 `@local/dsh-botmode`
- Client 模块：`@local/dsh-botmode/client`
- 状态根：`$DSH_HOME/botmode`

改完代码后，用 Plugin Manager 关闭再打开 `include:botmode` 即可重载 Host；Client 改动刷新页面即可（若在跑 `pnpm run dev:web`，会热更新）。

## 使用

1. 侧边栏点机器人图标，或底部 `Bot 模式`，进入 Bot 页面。
2. `新建` 一个 Bot：名字、角色、常驻指令、分组、模型、工具白名单、审批策略。模型默认跟随 **DSH 默认模型**；也可以单独指定 provider/model、思考档位（reasoning effort）和视觉能力。表单从 Host 的实时模型目录读取：每个模型会标出可选的思考档位与是否支持图片输入，纯文本模型不能给 Bot 发图。
3. 创建后会立刻生成目录与身份文件，并创建一个 canonical Session。
4. 在 Bot 详情里直接聊天；回复按官方轨迹样式渲染：思考过程可折叠、正文 Markdown/代码块、工具调用行可展开参数与输出，流式时有 shimmer 与光标。输入框可附加 PNG/JPEG/WebP/GIF 图片（最多 6 张、每张 12 MB），前提是这个 Bot 当前绑定的模型声明了图片输入能力；纯文本模型会在发送时被 Host 拒绝。`定时例程` 区域可以建 cron、立即跑、暂停、删除。
5. 建 Group Room：选 2–6 个 Bot，选路由模式，发一条消息。`@某个Bot` 指定先手；回复里 `@别人` 接力，`@user` 会暂停并标记“需要你”。
6. 需要审批时，页面顶部出现审批条：允许一次 / 本会话允许 / 总是允许 / 拒绝。

## 目录结构

```
packages/dsh-botmode/
  index.js              Host 插件入口：服务、工具、命令、HTTP、approval 桥、Memory Hub 挂载
  client.js             Client 模块：Bot 页面、群聊界面、Memory Hub 管理页、侧边栏入口、i18n、CSS
  host/
    store.js            state.json (v4) 原子写 + 串行 mutate；Bot/Room/Memory 目录与会话映射
    persona.js          SOUL.md / MEMORY.md / TEAM.md / team skill 与记忆库静态块渲染
    dispatch.js         会话级 FIFO、隐藏 Group Session、模型/图片、Memory prefetch/syncTurn、message_agent 链式护栏
    models.js           实时模型目录、DSH 默认模型解析、思考档位与视觉能力
    room-protocol.js    纯函数群聊协议：非指令文本剥离、精准 @mention、零 Token Actor 路由过滤、报错指纹计算、增量 delta 与任务板注入
    room-locks.js       共享任务板（claim_subtask）与 DSH 文件修改工具（write/edit/apply_patch/str_replace_editor）路径软锁校验
    rooms.js            终态驱动全异步 BotActor 并发总线（快照水位线防漏看、completed/settled/waiting_user、三大异常探针、Soft Steer）
    routines.js         持久 cron 调度器（冷会话唤醒）
    cron.js             五段 cron 解析与下一次时间
    approvals.js        Bot 审批桥（覆盖私聊与隐藏群聊会话）
    api.js              /botmode/api/state + /models + /memory + /image + /command
    memory/
      protocol.js       Hermes 风格 MemoryProvider 基类、manifest 校验、无意义短语门控
      manager.js        全局单选 Memory Hub 编排器（内置+外部发现、热切换、按 agent_id 隔离）
      installer.js      记忆库下载安装器（catalog / npm / git / tarball / local 校验与卸载）
      catalog.js        预置可一键安装的记忆库模板（Mem0 / Generic HTTP）
      providers/
        memory_tencentdb/   内置 TencentDB 四层记忆库插件（v3 Gateway 8420 + 熔断 + SQLite FTS5 自动降级）
        local_sqlite/       内置纯本地 Node 22 SQLite FTS5 记忆库插件
        builtin/            内置纯 MEMORY.md 文件模式
  test/host.test.mjs    Host 逻辑全量无头测试
  cordis.patch.yml      插入 Host 行
  package.json          dsh.bundle.patch + dsh.client
```

持久状态：

```
$DSH_HOME/botmode/
  state.json                     sections / bots / rooms / routines / memory
  rooms/<roomId>.jsonl           Group Room append-only 完整事件日志
  memory-plugins/<id>/           用户下载安装的外部记忆库插件（plugin.json + index.js）
  memory-data/                   本地 SQLite FTS5 记忆数据库（fallback 与 local_sqlite）
  bots/TEAM.md                   团队名册
  bots/roster.json               机器可读名册
  bots/<slug>-<id6>/
    bot.json                     该 Bot 的完整记录
    SOUL.md                      人格与常驻指令
    MEMORY.md                    长期记忆（Bot 可自己改）
    .dsh/skills/team/SKILL.md    如何用 message_agent 与 memory 工具
```

## Host API

所有请求先过 dsh 的 Connection 同源/登录栅栏；未登录返回 401。

- `GET /botmode/api/state` → roster、sections、rooms（含 transcript/activity/watermarks/预算/运行态）、routines、approvals、memory 摘要、工具名、状态根
- `GET /botmode/api/models[?force=1]` → 实时 provider/model 目录、每个模型的思考档位与 `vision` 能力、当前 DSH 默认选择
- `GET /botmode/api/memory` → 完整 Memory Hub 状态、已安装记忆库、可下载目录与实时健康探测
- `POST /botmode/api/image`，body 为图片二进制，`content-type` 为 `image/png|jpeg|webp|gif` → `{ ok, attachment }`
- `POST /botmode/api/command`，body `{ type, ... }`
- `GET /botmode/api/remote[?qr=0]` → Remote 运行态、App 链接、二维码（详见 [DETAIL.md](../packages/dsh-botmode/docs/DETAIL.md)）
- `GET /botmode/api/screen/{status,preview,stream,audit}`、`POST /botmode/api/screen/{input,files}` → BotScreen 管理面代理
- `GET|PUT /botmode/api/avatar`、`GET /botmode/api/avatar/catalog`、`GET /botmode/api/avatar/bundle.js` → 形象偏好、目录与引擎产物
- `GET|POST|DELETE /botmode/api/artifacts`、`POST /botmode/api/artifacts/bundle` → 产物列表、发布、删除、打包 ZIP
- `POST /botmode/api/webhook/<id>` → 入站事件触发（Bearer / `X-Botmode-Secret` / HMAC-SHA256）

命令：

| type | 参数 | 说明 |
| --- | --- | --- |
| `bot.save` | `botId?`, `draft` | 新建/更新；新建会建目录、建会话、写身份文件 |
| `bot.delete` | `botId` | 删记录、停调度、删目录、重写团队文件 |
| `bot.dispatch` | `botId`, `text`, `images?` | 入队一条用户消息；`images` 是 `/botmode/api/image` 返回的附件引用数组 |
| `bot.stop` | `botId` | 取消当前 turn |
| `section.save` / `section.delete` | `sectionId?`, `name` | 分组 |
| `room.save` / `room.delete` | `roomId?`, `draft` | Group Room（含 `mode` / `leadBotId` / `workDir` / `purpose` / `notes` / `tokenLimit` / `idleRoundLimit` / 可选 `maxRounds` `maxMessages`） |
| `room.send` / `room.control` | `roomId`, `text` / `action` | 发消息（默认 Soft Steer 软插话，`/stop` 强停）/ `continue` `stop` `resume_bot` |
| `routine.save` / `routine.delete` / `routine.toggle` / `routine.run` | 见页面 | 例程 |
| `approval.decide` / `question.decide` | `approvalId` / `questionId`, `decision` / `answers` | 工具审批 `once` `session` `always` `deny` 与交互提问回答 |
| `memory.select` | `providerId` | 全局热切换所有 Bot 使用的记忆库插件 |
| `memory.configure` | `providerId?`, `teamId?`, `userId?`, `prefetchEnabled?`, `syncEnabled?`, `syncGroupRooms?`, `config?` | 更新记忆策略或插件配置并热重载 |
| `memory.test` | `providerId?` | 探测记忆库连通性与运行模式 |
| `memory.install` | `source`, `activate?`, `overwrite?` | 从目录模板 / npm / Git / tarball / 本地目录下载安装其他记忆库插件 |
| `memory.uninstall` | `providerId` | 卸载外部记忆库插件（内置受保护） |
| `memory.search` | `botId`, `query`, `limit?` | 按指定 Bot 隔离空间测试记忆检索 |
| `remote.status` / `remote.up` / `remote.down` | — | Remote 网关运行态、起网关（等到 `/__dsh/health` 200）、停止映射 |
| `remote.rotate` / `remote.rotateApp` | — | 轮换对外 PSK / App 直连 token 并回传新链接 |
| `remote.inspect` | `link` | 校验一条 `dsh-remote` 链接（CLI 与其他面板复用） |
| `webhook.test` | `id` | 触发一次入站 Webhook 自测 |

## 工具与命令

Host 注册的工具（仅 Bot 主会话或隐藏群聊会话可用）：

- `message_agent({ target, message, expectReply? })`：异步队友消息（含 4 跳防环、同链去重、目标歧义校验；群聊隐藏会话禁用）。
- `bot_team({ action: roster|me|rooms })`：名册、自己的身份（含精确 `inRoom`/`running`/`queued`）、所在 Room。
- `bot_manage` / `room_manage`：Agent 自己创建 / 编辑 / 删除 Bot 与群聊（受审批闸门约束）。
- `scheduled_tasks`：建 / 改 / 跑 / 停自己的 cron 例程（`host/scheduler/`）。
- `room_task_progress`：群聊任务板进度上报（与 `claim_subtask` / `room_finish_task` 配套）。
- `screen_screenshot` / `screen_click` / `screen_type` / `screen_key` / `screen_scroll` / `screen_drag` / `screen_open_app` / `screen_windows` / `screen_request_help`：虚拟桌面操控与人类求助。
- `system_info` / `publish_artifact`：宿主机指标与产物发布。
- `claim_subtask({ taskId, title?, paths?, status? })`：群聊共享任务板认领、文件路径软锁声明与完成释放（仅群聊会话可用）。
- `room_finish_task({ summary, deliverables?, verification?, force? })`：显式验收并结束群聊任务进入 `completed` 终态（仅群聊会话可用；配置 Lead 时仅 Lead 可调用）。
- `memory_search` / `memory_tencentdb_memory_search`：检索当前 Bot 的 L1 原子记忆。
- `memory_conversation_search` / `memory_tencentdb_conversation_search`：检索当前 Bot 的 L0 历史对话。
- `memory_read_scene` / `memory_tencentdb_read_scene`：列出或读取当前 Bot 的 L2 场景块。
- `memory_save`：显式持久化一条长期事实、偏好或决策到当前 Bot 的记忆空间。

人类命令：

```
/botmode status
/botmode roster
/botmode dispatch <bot> <text>
/botmode room <roomId> <text>
/botmode routine <routineId>
/botmode memory status|list|use <id>|test|install <source>|uninstall <id>
/botmode scaffold
```

## 测试

```bash
node packages/dsh-botmode/test/host.test.mjs
```

覆盖：cron 解析、store/身份文件、Dispatcher 会话隔离与 FIFO、默认模型与单独模型绑定、图片能力校验与图片消息、模型目录、Group Room 协议纯函数（引号/代码块防误触、`@all`/`@user`/`@你`、`(pass)` 归一化、顺位轮转）、Group Room 多轮状态机（隐藏群聊会话、多跳接力、提交前 Watermark 防漏看、全员 pass 收敛 `settled`、上限 `capped`、`stop` 取消与 Epoch 插话打断）、`message_agent` 跳数与去重护栏、Memory Hub（`memory_tencentdb` v3 HTTP Gateway + 离线自动本地 SQLite FTS5 降级、Bot 间隔离、`local_sqlite` 切换、目录模板与本地插件下载安装/卸载）、审批策略、API 全端点。

## 边界与已知限制

- `/new`、`/reset` 的压缩依赖当前组合里装了 compaction 引擎；压缩前会调用记忆库 `onPreCompress` 钩子。
- Bot 的模型变更在**下一次 turn**前由 Host 重新绑定；记忆库切换立即热生效于所有后续 turn 的 `prefetch` / `syncTurn` 与工具调用，静态 system prompt 块在新建/恢复会话时更新。
- 图片输入需要模型在提供方声明的 `inputModalities` 里包含 `image`。
- 审批条依赖 Bot 页面打开；无人值守时 2 分钟自动拒绝，避免 Routine 或群聊卡死。
- 所有 Bot 共用一个 Host 进程、各自独立私聊会话与按群隔离的隐藏群聊会话。
- `lib/` 编译产物未生成，当前直接发 ESM 源码；Node 内置模块 + 相对导入，避免 profile 解析第三方依赖。