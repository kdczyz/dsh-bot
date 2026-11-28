# dsh-quay-bot

DeepSeek Harness 的 **Bot 团队模式**插件（Host + Web Client 双半区），并内置一套自举的 **BotScreen 虚拟桌面**（X + 窗口管理器 + 把画面流进 Web UI）。装完即用：Python 依赖走包内 wheel，系统组件在首次启动时自动补装，不需要手工 `pip install` / `apt install`。

```bash
dsh plugin install dsh-quay-bot          # 在目标 profile 里
# 或在 DSH 桌面端 Plugin Manager → Install → 输入 dsh-quay-bot
# 或在 Discover 页把下面「Market index」里的 URL 加成索引源后直接搜索安装
```

---

## 1. 这个包做了什么

- 每个 Bot 独立目录、`SOUL.md` / `MEMORY.md`、永久私聊会话，以及**按房间隔离的隐藏 Group Session**（支持房间共享工程目录 `workDir`）
- **独立整页**：进入 Bot 模式后外壳工作区侧栏让位，只留 Bot 会话侧栏；侧栏可折叠成 56px 头像轨道（`localStorage` 记忆状态），折叠时仍可切 Bot、新建、进设置、回 Harness
- **对话历史由 Host 折叠**：Bot 会话在 Bot 自己的目录下，浏览器端会话列表不收它，Host 直接读该会话日志折成对话（`GET /botmode/api/transcript`）。历史里带思考过程与工具调用（名称 / 参数 / 输出 / 状态），用实时视图同一套组件渲染；切 Bot 自动载入，运行中每 3 秒、空闲每 12 秒按 `after=<seq>` 增量追新
- 每个 Bot 可单独绑定模型：DSH 默认（空绑定，每轮重读）、provider/model、思考档位；模型目录标注是否支持图片输入
- Bot 聊天可发图片（PNG/JPEG/WebP/GIF，≤6 张 × 12 MB），纯文本模型在 Host 入队前拒绝
- `message_agent` 异步队友消息（会话级 FIFO、跳数护栏 `MAX_AGENT_HOPS=4`、同链去重、回信降级、>16k 落盘、群聊隐藏会话禁止）
- **Group Room（2–6 人）**：`auto`（并发协作 + `@` 接力）/ `everyone`（全员并发审阅）/ `lead`（Lead 派工与验收）；全异步 `BotActor` 总线 + `snapshotSeq` 水位线防漏看；3 种显式终态（`completed` / `settled` / `waiting_user`）；3 个病态探针（`idle_spin` / `paused_error` / `token_budget`）；共享任务板 `claim_subtask(taskId, paths)` + 文件软锁；前端按 `botId` 分轨流式渲染；人类中途发言走 Soft Steer 软插话
- **Memory Hub**：`memory_tencentdb`（v3 HTTP Gateway `127.0.0.1:8420`，熔断后自动降级 Node 原生 SQLite FTS5）、`local_sqlite`、`builtin`，支持页面/命令一键下载安装第三方记忆库
- Host 持久 Routines（cron + 冷会话唤醒）、审批与提问桥（`approval/request`、`user-questions/request`）
- **BotScreen 屏幕工具**：`screen_screenshot` / `screen_click` / `screen_type` / `screen_key` / `screen_scroll` / `screen_drag` / `screen_open_app` / `screen_windows` / `screen_request_help`，网关 `127.0.0.1:6200`

---

## 2. 依赖：一个都不用手动装

| 层 | 内容 | 包内自带？ |
|---|---|---|
| Node | ≥ 22.13（`node:sqlite` 需无 flag 版本）；DSH 本体要求 ≥ 24.9 | DSH 侧负责 |
| DSH | `>= 0.2.2-rc.3`（写进 `engines.dsh`，不满足会被安装器拦下） | — |
| JS 依赖 | **零**（无 `dependencies`；只动态 `import` 可选的 `@deepseek-ai/dsh-mcp-client`，缺失自动降级） | ✅ |
| Web Client | `dsh-client-locale` / `ui-layout` / `ui-sidebar` / `ui-workspace` / `dsh-api-session-controller` | 由 DSH 提供 |
| Python | `fastapi uvicorn python-multipart Pillow python-xlib websockets httpx mss` | ✅ `vendor/wheels/` 离线 wheel（linux **x86_64 + aarch64**，CPython **3.12**） |
| pip 自身 | `vendor/pip/` 内置 `pip` + `setuptools` wheel（宿主机没有 ensurepip 也能建 venv） | ✅ |
| 系统组件 | `xvfb x11vnc websockify novnc xauth xfwm4 xfdesktop4 xfconf dbus-x11 tint2 picom pcmanfm xterm xdotool xclip glib-networking gvfs gvfs-daemons feh adwaita-icon-theme fonts-noto-color-emoji fonts-noto-cjk` | 首次启动自动 `apt-get install`（需 root 或无密码 sudo） |
| 运行时底座 | cgroup v2 unified（屏幕冻结）、`Xvfb`（或 KasmVNC 提供的 `Xvnc`） | 检测/自动装 Xvfb；KasmVNC 可选 |

首次启动的顺序（`host/screen.js` → `bootstrapVenv` / `ensureSystemDependencies`）：

1. 探活 `127.0.0.1:6200/healthz`，已就绪直接复用；
2. 找 Python：`BOTSCREEN_PYTHON` → `$DSH_HOME/botmode/screen-venv` → 插件内 `.venv` → 仓库 `.venv` → `python3`（只要它的 import 探针通过就原地用）；
3. 否则建 venv，用包内 pip wheel 播种，再 **离线** `pip install --no-index --find-links vendor/wheels/{any,linux-<arch>}`；wheel 不匹配解释器（如 3.10/3.11/3.13）时回退 PyPI，仍是全自动；
4. 逐项探测 14 个系统 bin，缺哪个就 `apt-get install` 全套一次（无 root/免密 sudo 时打印可复制的一行命令，不阻断其它功能）；
5. 拉起 `python -m botscreen`，写日志 `$DSH_HOME/botmode/botscreen-gateway.log`。

关掉自动安装：`BOTSCREEN_AUTO_INSTALL_DEPS=0`。

---

## 3. 自检

```bash
npx dsh-quay-bot            # 人类可读报告（node / python / 系统 bin / 内置 wheel / 网关）
npx dsh-quay-bot --json     # 给脚本用
npx dsh-quay-bot --fix-hint # 只输出需要执行的命令
```

常见环境变量：`DSH_HOME`、`BOTSCREEN_DATA_ROOT`（默认 `/data/botscreen`）、`BOTSCREEN_PORT`（6200）、`BOTSCREEN_PYTHON`、`BOTSCREEN_X_BACKEND`（`xvfb`/`x11vnc`）、`BOTSCREEN_WM`（`openbox`/`xfwm4`）、`BOTSCREEN_WIDTH` / `BOTSCREEN_HEIGHT`、`BOTSCREEN_IDLE_MODE`。

---

## 4. Market index（Discover 页搜索）

包内提供一份符合 DSH plugin market format 1 的索引：`market/index.json`。把它放到任意 https 可访问地址（或本机 http），在 DSH 的 Discover / 插件市场设置里添加为索引源，即可在页面里搜到 `dsh-quay-bot` 并一键安装：

```json
{
  "format": 1,
  "title": { "en": "Quay Bot", "zh": "Quay Bot 团队模式" },
  "metadata": { "updated": 1764276000 },
  "plugins": [
    {
      "name": "dsh-quay-bot",
      "versions": [
        { "version": "1.0.0", "publishTimestamp": 1764276000, "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.2-rc.3" } }
      ]
    }
  ]
}
```

索引 URL 必须能被 DSH 以 `https:`（或同源的 http）读取；`source.type: "npm"` 会解析成 `dsh-quay-bot@1.0.0` 交给 profile 的包管理器。

---

## 5. 安装后去哪里找

- Host 行：`include:botmode`，模块 `dsh-quay-bot`
- Client 模块：`dsh-quay-bot/client`（侧边栏底部「Bot 模式」+ 机器人图标 → `main` 面板 `botmode`）
- 状态根：`$DSH_HOME/botmode`（`state.json` v4、`rooms/`、`bots/`、`memory-data/`、`memory-plugins/`、网关日志）
- HTTP：`/botmode/api/state`、`/models`、`/memory`、`/image`、`/command`、`/screen/*`、`/avatar/*`、`/artifacts/*`

改代码后：Plugin Manager 里关再开 `include:botmode` 重载 Host；Client 改动刷新页面即可（跑着 `pnpm run dev:web` 会热更新）。

---

## 6. 测试

```bash
node test/host.test.mjs && node test/screen.test.mjs && node test/avatar.test.mjs \
  && node test/artifacts.test.mjs && node test/routines.test.mjs && node test/qr.test.mjs \
  && node test/remote.test.mjs && node test/isolation.test.mjs && node test/governance-channels.test.mjs
```

覆盖 cron 解析、store/身份文件、会话隔离与 FIFO、模型与图片能力、Group Room 协议纯函数与多轮状态机、`message_agent` 护栏、Memory Hub（含降级路径）、审批策略、全部 HTTP 端点、venv 自举与系统依赖探测。

---

## 7. 与 `@local/dsh-botmode` 的关系

本包是同一套源码的**公开发布版**：包名、`dsh.bundle.patch` 的插件名、`client` 模块 id 改为 `dsh-quay-bot`；补上 `builtin-skills/**` 与 `vendor/wheels/**`；`bootstrapVenv` 改为离线优先；`ensureSystemDependencies` 从「5 个 bin」扩到「14 个 bin」。状态根、数据格式、`teamId=dsh-botmode` 保持不变，已有 Bot / 房间 / 记忆库可原样沿用。

同一 profile 里不要与 `@local/dsh-botmode` 同时启用（两者都插入 `include:botmode`）。