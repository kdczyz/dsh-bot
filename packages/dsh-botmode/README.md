# @local/dsh-botmode

DeepSeek Harness 的 Bot 团队模式插件（Host + Web Client 双半区，v0.5.0）。

- 每个 Bot 独立目录、SOUL/MEMORY、永久私聊会话，以及**按房间隔离的隐藏 Group Session**
- 每个 Bot 可单独绑定模型：DSH 默认（空绑定，下一轮重新读取）、provider/model、思考档位；模型目录标出是否支持图片输入
- Bot 聊天可发图片（PNG/JPEG/WebP/GIF），纯文本模型由 Host 在入队前拒绝
- `message_agent` 异步队友消息（会话级 FIFO、跳数护栏 `MAX_AGENT_HOPS=4`、同链去重、回信降级、>16k 落盘、群聊隐藏会话严格禁止）
- **Hermes 风格 Group Room 状态机**：
  - 2–6 人，支持 `auto`（智能多轮）/ `everyone`（全员顺位轮转）/ `lead`（Lead 统筹按 `@` 接力）
  - 剥离代码块、行内代码、引用行与引号举例后的精准 `@mention`、`@all`/`@everyone` 与 `@user`/`@你` 解析
  - 每成员独立水位线 `watermark` 增量投喂（提交模型调用前捕获 `deliveredThrough`，防止并发插话漏看）
  - `(pass)` / `（pass）` / `[NO_REPLY]` 静默归一化（隐藏气泡、记入房间活动流）+ 全员静默自然收敛 `settled`
  - 可按群配置 `maxRounds` / `maxMessages` 硬上限并明确标记 `capped`（不伪装为 `idle`/`settled`）
  - 单驱锁 + `stop` 立即取消当前 turn + Epoch 纪元插话打断与自动重启 + JSONL 完整事件归档
- **全局可插拔团队记忆库（Memory Hub）**：
  - 所有 Bot 共用一套全局激活的记忆库插件，按 `team_id` + `agent_id (= bot.id)` + `user_id` 严格隔离各 Bot 记忆
  - 默认内置 `memory_tencentdb`（对接 v3 HTTP Gateway `127.0.0.1:8420`，支持 L0–L3 并行预取与异步写入、熔断保护，网关未启动时自动回退至 Node 22 原生 SQLite FTS5）
  - 同时内置 `local_sqlite`（纯本地零依赖 SQLite FTS5）与 `builtin`（仅 `MEMORY.md`）
  - 支持在页面或 `/botmode memory install` 一键下载、安装、配置、热切换与卸载其他记忆库插件（支持目录模板、npm 包、Git 仓库、tarball URL、本地插件目录）
- Host 持久 Routines：cron 解析 + 冷会话唤醒，定时器在 `ctx.effect()` 内
- Bot 审批桥：once / session / always / deny（同时覆盖私聊与隐藏群聊会话）

安装（桌面端）：

```bash
dsh plugin --profile desktop install /path/to/dsh-bot/packages/dsh-botmode
```

状态根：`$DSH_HOME/botmode`。HTTP：`/botmode/api/state`、`/botmode/api/models`、`/botmode/api/memory`、`/botmode/api/image`、`/botmode/api/command`。

测试：

```bash
node packages/dsh-botmode/test/host.test.mjs
```

完整架构、命令表与限制见仓库根目录 [README.md](../../README.md)。
