# BotScreen

轻量级多 Bot 虚拟屏系统（Linux）。每张虚拟屏 = 独立 X server（KasmVNC）+ 极简窗口管理器（Openbox）+ 独立 HOME + 独立 cgroup v2 子组，闲置时内核级冻结到 **CPU 0%**，收到 Agent 或人类请求后毫秒级唤醒，窗口/表单/标签页完整保留。

已在本机验证：Ubuntu 24.04 aarch64 / cgroup v2 / KasmVNC 1.5.2 / Chrome 真实页面输入。

---

## 1. 架构

```
┌──────────────────────────────────────────────────────────────┐
│ 接入层  控制台 (web/index.html)  │  noVNC 接管窗口 (KasmVNC)   │
├──────────────────────────────────────────────────────────────┤
│ 控制平面 Screen Gateway (FastAPI, 127.0.0.1:6200)            │
│   · REST 管理面   · Agent 操控面   · WS 推流代理 + 互斥锁      │
│   · 状态机        · idle_reaper   · watchdog                  │
├──────────────────────────────────────────────────────────────┤
│ 实例层  Xvnc :101 / openbox   × N（每 Bot 独立实例）          │
├──────────────────────────────────────────────────────────────┤
│ 底座层  cgroup v2 (freeze) → zram → Xauthority / 目录隔离      │
└──────────────────────────────────────────────────────────────┘
```

编号映射（`bot_NN` → 序号 `n`）：

| 资源 | 公式 | 示例 |
|---|---|---|
| X11 DISPLAY | `100 + n` | `:101` |
| KasmVNC websocket 端口 | `6100 + n`（仅 127.0.0.1） | `6101` |
| cgroup v2 | `/sys/fs/cgroup/botscreen/{bot_id}` | `/sys/fs/cgroup/botscreen/bot_01` |

---

## 2. 快速开始

```bash
./install.sh                     # 装依赖 + KasmVNC + zram + 目录 + 自检
.venv/bin/python -m botscreen    # 启动网关
open http://127.0.0.1:6200/      # 控制台
```

装成系统服务（开机自启）：

```bash
./deploy/install-systemd.sh
```

环境变量（全部有默认值）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `BOTSCREEN_PORT` | `6200` | 网关端口 |
| `BOTSCREEN_HOST` | `127.0.0.1` | 网关监听地址 |
| `BOTSCREEN_BOTS` | `bot_01,bot_02,bot_03,bot_04` | 注册的屏 |
| `BOTSCREEN_DATA_ROOT` | `/data/botscreen` | 数据根目录 |
| `BOTSCREEN_IDLE_FREEZE` | `180` | 闲置多少秒自动冻结 |
| `BOTSCREEN_LONG_FREEZE` | `300` | 超过多少秒的冻结唤醒后带 `resumed_from_long_freeze` |
| `BOTSCREEN_WEBHOOK_URL` | 空 | `request_human_help` 推送（飞书/Telegram/Slack） |
| `BOTSCREEN_AUDIT` | `1` | 是否落审计缩略图 |
| `BOTSCREEN_RECLAIM_PCT` | `60` | 冻结后换出到 swap/zram 的内存比例（0 关闭） |
| `BOTSCREEN_STOP_ON_EXIT` | `0` | 网关退出时是否清屏（默认保留，重启零中断） |
| `BOTSCREEN_MIN_FREE_MB` | `1024` | 拉起新屏前要求的最小可用内存（0 关闭门禁） |
| `BOTSCREEN_SCREENSHOT_FAIL_CLOSED` | `1` | 人类持有时是否连 Agent 截图一并拒绝 |
| `BOTSCREEN_RECLAIM_MAX_MB` | `96` | 单次回收上限（防止大屏在内核里等太久） |
| `BOTSCREEN_DEPTH` | `32` | X 屏色深。**必须 32**才有 ARGB visual，dock 才能透明圆角 |
| `BOTSCREEN_WM` | `xfwm4` | 窗口管理器：`xfwm4` 或 `openbox`（openbox 会顶掉 dock 位置） |
| `BOTSCREEN_DESKTOP` | `1` | 是否铺桌面壳（壁纸 + 桌面图标 + dock + 合成器） |
| `BOTSCREEN_CAPTURE` | `xlib` | 截屏后端：`xlib` / `mss` |

---

## 3. 状态机与互斥

| 状态 | CPU / 推流 | 允许 |
|---|---|---|
| `STOPPED` | 0 / 关 | 仅 start |
| `STARTING` | 启动中 | — |
| `FROZEN` | **0.0%** / 关 | Agent 请求 / 人工打开 → 毫秒唤醒 |
| `AGENT_ACTIVE` | 活跃 | Agent 截屏 + 键鼠 |
| `HUMAN_TAKEOVER` | 活跃 / 强制 | 人类全权；Agent 键鼠返回 **423 Locked** |
| `NEED_HUMAN` | 活跃 / 待连接 | Agent 求助，等待人类接入 |

- **人类抢占**：控制台点「接管」，或人类在画布上产生键鼠事件（网关在 WS 代理里识别 RFB `KeyEvent=0x04` / `PointerEvent=0x05` 帧）→ 自动切 `HUMAN_TAKEOVER`。
- **交还**：`POST /api/screens/{bot}/release` → `AGENT_ACTIVE`，阻塞中的 Agent 被唤醒。
- **双信号闲置**：`上次 Agent 调用 + 上次人类输入` 均超过 `IDLE_FREEZE` **且** `viewers == 0` → 自动 `cgroup.freeze=1`。

### 3.1 租约（lease）落盘 + epoch

控制权不只在内存里：每次迁移都写 `runtime/lease.json`（`flock` + 原子 `os.replace`），网关重启后据此恢复。

```json
{"bot_id":"bot_01","holder":"agent","state":"FROZEN","epoch":2,
 "since":1795652309.2,"reason":"idle","pid":1415789}
```

- `epoch` 每次迁移 +1。Agent 可以在请求里带 `X-Expected-Epoch: N`，控制权在你上次调用后被切换过就得到 **409**，
  响应体给出 `expected_epoch → current_epoch`；不要带着旧 epoch 继续操作。
- `holder` 只有 `agent` / `human`。
- **fail-closed**：`lease.json` 存在但读不出来或格式非法 → 一律当 `human` 持有，Agent 所有操作（含截图）返回 423。
  宁可误挡，也不在"人正在输密码"时放行。

### 3.2 人类持有时截图也被拒

`BOTSCREEN_SCREENSHOT_FAIL_CLOSED=1`（默认）下，`HUMAN_TAKEOVER` 期间 `/api/agent/{bot}/screenshot` 返回 **423**，
`blocked: "screenshot"`。理由与 Hermes 一致：人可能在输入凭据，不能"相信 Agent 会自己暂停"。

控制台的 `/api/screens/{bot}/preview` **不受**此限——那是给人看的只读旁观画面，不经过 Agent 身份。

`NEED_HUMAN` 状态是例外：键鼠被挡，但**允许截图**，Agent 需要看到人是否已处理完。

---

### 3.3 启动门禁（内存）

`POST /api/screens/{bot}/start` 前会检查可用内存，取 cgroup 限额余量与 `MemAvailable` 的**较小值**；
不足 `BOTSCREEN_MIN_FREE_MB` 时返回 **409** 而不是硬拉起：

```json
{"detail":"内存不足，暂不拉起虚拟屏：可用 14588 MB / 限额 23972 MB，需要至少 99999 MB …",
 "blocked":"memory","available_mb":14588,"limit_mb":23972}
```

控制台会在顶部显示这条警告条，`GET /api/screens` 也会带 `host` 段。

### 3.3.1 自研桌面图标层（绕开 trusted 机制）

xfdesktop 和 pcmanfm/libfm 对 `.desktop` 的信任判断互相矛盾（一个要 x 位、一个不要），
且都依赖 gvfs 的 `metadata::trusted`——容器里这个标记和它们读到的那份不同源，首次双击总要确认一次。

`botscreen/iconlayer.py` 用 **python-xlib + PIL** 自己画图标、自己处理点击：

* **单窗口合成**：一个 1280×720 的全屏窗口，把壁纸和 4 个图标画在同一张图里，
  窗口类型 `_NET_WM_WINDOW_TYPE_DESKTOP` → xfwm4 放在桌面层。
  （早先是每个图标一个小窗口，和 xfdesktop 同为 DESKTOP 类型会互相覆盖，
  刷新后图标被壁纸窗口盖住 / 只剩蓝方块——单窗口方案把这个层级问题彻底消掉。）
* 不依赖 ARGB visual（Xvfb 只有 24 位，做不了真透明；整屏合成绕开了它）；
* 全屏图必须**分条上传**：X 的 PutImage 请求长度是 CARD16（4 字节为单位），
  单次上限 256 KB，py-xlib 更保守；1280×720×4B = 3.6 MB，按 8 行一条（40 KB）循环 put_image；
* 双击间隔 < 450ms 触发 `Popen(cmd, shell=True)`；右键不拦截（桌面右键仍归 xfdesktop）；
* 与 `.desktop`、`gio set`、`gvfsd-metadata` 完全无关 —— **第一次点就是执行，没有任何确认框**。

```bash
python -m botscreen.iconlayer --display :101 --home <bot home> --assets <assets dir>
```

三个 py-xlib 的坑：`change_property` 的 property 参数必须是 **Atom 对象**（`dpy.get_atom`），
`put_image` 的签名是 **`(gc, x, y, width, height, format, depth, left_pad, data)`** —— 参数顺序错一位就会报
`TypeError: object of type 'int' has no len()`；单次数据超过 64 KB 会报 `struct.error: 'H' format requires 0 <= number <= 65535`，
所以整屏要分条画。

### 3.4 桌面壳（壁纸 / 桌面图标 / 顶栏 / dock / 窗口装饰）

`start` 时自动铺设，全部在 bot 自己的 `HOME` 内隔离：

| 组成 | 实现 | 说明 |
|---|---|---|
| 窗口管理器 | **xfwm4** | 提供标题栏 + 最小化/最大化/关闭按钮、拖拽、Alt+Tab 切换。openbox 会强制重定位 dock，已弃用 |
| 合成器 | **picom**（xrender） | dock 圆角/半透明依赖它，需要 32 位深度（ARGB visual） |
| 壁纸 | **pcmanfm --desktop** | `pcmanfm --set-wallpaper=<assets>/wallpaper.png` |
| 桌面图标 | **自研图标层**（`botscreen/iconlayer.py`） | 左侧竖排 4 个：**回收站 / 浏览器 / 文件系统 / 主文件夹**。窗口类型 `_NET_WM_WINDOW_TYPE_DESKTOP`，双击直接执行，**不经过任何“可信启动器”机制** |
| 桌面右键菜单 | pcmanfm | 新建文件夹 / 粘贴 / 打开终端 / 桌面设置 |
| 顶部状态栏 | 第二个 **tint2** 实例（`topbar.tint2rc`） | 0×0 → 1280×30，任务栏 + 系统托盘 + 时钟 |
| 底部 dock | **tint2**（`tint2rc`） | 圆角 16、半透明黑、居中、4 个启动器：浏览器 / 搜索 / 终端 / 文件夹 |
| 图标资源 | 包内 PIL 生成 | `tools/make_desktop_assets.py`，运行时不依赖绘图库 |
| 搜索页 | 本地 `search.html` | dock 搜索按钮用 Chrome `--app` 打开，回车跳 Bing |

`GET /api/screens/{bot}` 的 `desktop` 段给出 `started / assets / dbus / procs`。

## 4. REST API

管理面（仅监听 127.0.0.1）：

```
GET    /api/screens                     所有屏状态
GET    /api/screens/{bot}               单屏状态（状态机 / 内存 / PID / 迁移记录）
POST   /api/screens/{bot}/start         {"apps":[["google-chrome","--no-sandbox","URL"]]}
POST   /api/screens/{bot}/stop
POST   /api/screens/{bot}/freeze        cgroup.freeze=1（CPU 归零）
POST   /api/screens/{bot}/thaw          cgroup.freeze=0（10~50ms）
POST   /api/screens/{bot}/takeover      返回 {token, stream_url}
POST   /api/screens/{bot}/release
POST   /api/screens/{bot}/brake         单屏制动：冻结 + 轮换 Token
POST   /api/brake                       全局制动：全部冻结 + 全部 Token 失效
GET    /api/screens/{bot}/preview       只读缩略帧（冻结屏返回 409，不续命计时）
GET    /api/screens/{bot}/audit?limit=  actions.jsonl 尾部
GET    /api/screens/{bot}/audit/thumb/{name}
GET    /api/screens/{bot}/files         POST 上传 / GET 下载 / DELETE 删除
GET    /healthz
```

Agent 面（需 `X-Agent-Token`，每个 Bot 独立，存于 `runtime/token.json`）：

```
GET  /api/agent/{bot}/screenshot?fmt=jpeg|webp|png
      → image + 头部 X-Screen-Width / X-Screen-Height / X-Screen-State
                X-Resumed-From-Long-Freeze / X-Focused-Window
POST /api/agent/{bot}/click   {"x":int,"y":int,"button":1..9,"double":bool}
POST /api/agent/{bot}/type    {"text":"中文✅","press_enter":bool}
POST /api/agent/{bot}/key     {"combo":"ctrl+l"}
POST /api/agent/{bot}/request_help {"reason":"验证码"}
POST /api/agent/{bot}/wait_release?timeout=60
```

`409` 有两种：`blocked: "memory"`（内存门禁）与 `detail: "Lease epoch changed"`（租约过期）。

`423` 响应体：

```json
{"detail":"Human in control","bot_id":"bot_01","state":"HUMAN_TAKEOVER",
 "hint":"等待人类点击『交还给 Agent』或超时重试"}
```

---

## 5. MCP 工具

`deploy/mcp.json` 可直接粘进任意 MCP 客户端配置：

| 工具 | 说明 |
|---|---|
| `screen_screenshot(bot_id, format)` | 自动唤醒冻结屏，返回图像 + 元数据 |
| `screen_click(bot_id, x, y, button, double)` | 互斥检查 + 审计 + 点击 |
| `screen_type_text(bot_id, text, press_enter)` | 剪贴板粘贴，中文/emoji 稳定 |
| `screen_key(bot_id, key_combo)` | 快捷键 |
| `request_human_help(bot_id, reason)` | 切 `NEED_HUMAN` + Webhook 通知 |
| `wait_human_release(bot_id, timeout)` | 被 423 后阻塞等待交还 |
| `screen_status(bot_id)` / `screen_list()` | 观测 |

---

## 6. 关键实现说明（踩过的坑）

1. **mss 在 KasmVNC 上不可用**：KasmVNC 的 X server 在同一个 `depth=24` 上暴露两组 depth 块，mss 只取第一组，报
   `drawable's visual not found in screen's supported visuals`。
   改用 **python-xlib ZPixmap** 直接抓 root window：5~8 ms，比 SHM 版更快，同样零视频流。
   需要回退时设 `BOTSCREEN_CAPTURE=mss`（仅在其 X server 布局兼容时）。
2. **xclip `-loops 1` 会丢内容**：它在粘贴请求到达前就退出，目标应用读到空剪贴板。
   改为常驻 holder（`-loops 0`）+ 90 ms 就绪等待 + 粘贴后回收。
   终端里 `ctrl+v` 不是粘贴（是 `^V`），可传 `paste_key="shift+Insert"` 或用中键。
3. **`-Auth`/Xauthority 与单进程多屏**：mss/xlib/xdotool 都从进程环境读 `XAUTHORITY`，而网关一个进程要服务 N 张屏。
   用 **共享 Xauthority 文件**（按 DISPLAY 分条目）解决，`BOTSCREEN_XAUTHORITY` 可覆盖路径。
4. **KasmVNC 强制 `Sec-WebSocket-Origin`**：网关代理上游时必须显式带该头，否则握手被拒；
   页面路径与 WS 路径都要以 `/websockify` 结尾。
5. **noVNC 会机械地给 `path` 补 `/`**：`path=/vnc/x/websockify` 会变成 `//vnc/...` 导致 403；
   传相对形式 `path=vnc/x/websockify`。
6. **KasmVNC 在 iframe 内会退化为 VDI 模式**（`isInsideKasmVDI`），不初始化 RFB 实例 → 黑屏。
   网关在返回 HTML 时把该检测改写为 `!1`；但更稳的用法是：内嵌只读旁观走网关截图流，实时操控走顶层新窗口。
7. **闲置计时基准**：Worker 启动时必须刷新 `last_agent_call`，否则 `idle_seconds` 为 `inf` 导致刚拉起的屏立刻被冻结。
8. **残留 X server**：上一轮异常退出会留下 `/tmp/.X{n}-lock` 与 `:n` 进程，启动前需按 DISPLAY 精确清理。
9. **`cgroup.freeze` 不会自动换出内存**：它只暂停进程，RSS 原样保留。冻结后再写
   `memory.reclaim` 才能把闲置匿名页推进 swap/zram（本机实测 235 MB → 94 MB）；
   没有 swap 时匿名页无法回收，只能回收 page cache。
10. **`xdotool mousemove --sync` 会假死**：指针已在目标坐标时 X 不再产生 motion 事件，
   `--sync` 会一直等到超时。改为非阻塞移动 + `getmouselocation` 校验。
11. **`memory.reclaim` 会同步阻塞**：内核在"可回收页不够"时会一直等到凑够才返回写入方。
    早期版本把它放在 `freeze()` 里同步调用，`/api/brake` 直接挂到 90 秒超时。
    现在改成子进程后台触发（`reclaim_async`），只在"本次真的从运行态转冻结"时做，并限制预算（默认 96 MB）。
12. **HTTP 头不能带非 Latin-1**：窗口标题含中文时，直接把标题放进响应头会 `UnicodeEncodeError`；统一 `json.dumps` 转义。

---

## 7. 目录规范

```
/data/botscreen/
├── Xauthority.shared            # 共享 X 授权（按 DISPLAY 分条目）
├── bot_01/
│   ├── home/                    # $HOME：浏览器配置 / 登录态隔离
│   │   ├── .vnc/kasmvnc.yaml
│   │   └── .config/openbox/     # 无边框 + 最大化
│   ├── downloads/               # 文件中转（前端直读）
│   ├── audit/
│   │   ├── actions.jsonl        # {ts, action, x, y, text, state, thumb}
│   │   └── thumbs/*.jpg         # 每动作一张缩略图（保留 400 张）
│   └── runtime/
│       ├── Xauthority           # 兼容占位
│       ├── token.json           # Agent Token（600）
│       ├── xvnc.log / openbox.log / apps.log
```

---

## 8. 运维

```bash
# 单屏起停/冻结/唤醒
curl -X POST localhost:6200/api/screens/bot_01/start
curl -X POST localhost:6200/api/screens/bot_01/freeze

# 观察冻结后 CPU（应恒为 0）
awk '/usage_usec/{print $2}' /sys/fs/cgroup/botscreen/bot_01/cpu.stat
cat /sys/fs/cgroup/botscreen/bot_01/cgroup.freeze

# 全局紧急制动
curl -X POST localhost:6200/api/brake
```

资源实测（cgroup `memory.current`；RSS 累加会把共享库重复计入，不可用于容量估算）：

| 场景 | 私有内存(anon) | 进程数 | CPU |
|---|---|---|---|
| 空屏 Xvnc+wm（冷启活跃） | 20.6 MB (19.9) | 2 | 0.05% |
| 空屏 + 桌面壳（xfwm4+picom+pcmanfm+双 tint2） | ≈ 80 MB | 10~11 | 0.1~0.3% |
| 空屏（冻结 + reclaim） | 9.6 MB (9.0) | 2 | **0** |
| 含 Chrome 静止页（冷启活跃） | 204 MB (174) | 13 | 0.06% |
| 含 Chrome（冻结 + reclaim） | 82.6 MB (60.7) | 13 | **0** |
| 含 Chrome（长冻结后） | 14~27 MB | 13 | **0** |
| 含 Chrome（Agent 循环操作） | — | 13 | ≈ 1.0% |

网关自身：RSS **60 MB** / CPU **0.1%**（4 vCPU 机器上 2 块屏 + 空闲时）。

容量推算（16 GB，按 80% 可用）：
每屏冻结态 10 MB → 理论上限 ~1300 屏，但真实瓶颈是 PID（空屏 2 / 带 Chrome 13）、
WS 端口段与内核 slab，工程上建议 **20~30 屏/16 GB**（与方案给出的数量一致）。
全部活跃含 Chrome 时每屏 ~200 MB → 一台 16 GB 机器最多约 60 屏，因此
**关键是让大部分屏处于冻结态**：30 屏里 5 屏活跃 + 25 屏冻结 ≈ 1.1 GB。

实测数字：

| 指标 | 数值 |
|---|---|
| 冷启动一屏（Xvnc + openbox ready） | 0.6 s |
| 抓帧 + JPEG 编码（driver 内） | 10~20 ms |
| 截屏 API 端到端（含审计写盘） | 42 ms / 50 KB |
| 点击 API 端到端（含审计缩略图） | 158 ms |
| 冻结 → 唤醒 | 11~30 ms |
| 冻结期间 CPU | 0 µs / 10 s（严格 0） |
| 全局制动（4 屏） | 7~22 ms（回收后台进行） |
| 窗口保真度（冻结 2s 前后像素 diff） | bbox = None（完全一致） |
| 中文/emoji 输入（xclip 常驻 + ctrl+v） | 成功，含 ✅ |

## 9. 自测脚本

```bash
.venv/bin/python tools/cdp_check.py /tmp/cdp   # 无头 Chrome 验证控制台 + 接管
```

## 9.0 X.Org xserver 后端（重构版）

默认后端已切换为 **上游 X.Org xserver 源码编译的 Xvfb**，推流层独立组合，不再依赖 KasmVNC：

```
Xvfb（gitlab.freedesktop.org/xorg/xserver，meson 构建）
   ↓ RFB
x11vnc（RFB 5950+N，仅 127.0.0.1）
   ↓
websockify（WS 6100+N + noVNC 静态）
   ↓
网关 WS 代理（token/cookie 鉴权）→ 浏览器 noVNC 客户端
```

构建（`install.sh` 里 `BOTSCREEN_BUILD_XVFB=1` 或手工）：

```bash
# 1) 新版 xorgproto（xserver 需要 xproto >= 7.0.34，Debian 13 只有 7.0.33）
git clone --depth 1 https://gitlab.freedesktop.org/xorg/proto/xorgproto.git
cd xorgproto && meson setup build -Dprefix=/data/home/xorgproto-install && ninja -C build && ninja -C build install

# 2) xserver 只要 Xvfb
git clone --depth 1 https://gitlab.freedesktop.org/xorg/xserver.git
PKG_CONFIG_PATH=/data/home/xorgproto-install/share/pkgconfig \
  meson setup xserver-build xserver -Dxvfb=true -Dxorg=false -Dxnest=false \
    -Dxephyr=false -Dxwayland=false -Dglamor=false -Ddri3=false -Dtests=false -Ddocs=false \
    -Dprefix=/data/home/xorg-install
ninja -C xserver-build          # 357 targets，4 vCPU 约 4 分钟，产出 hw/vfb/Xvfb（12 MB）

# 3) 运行
BOTSCREEN_X_BACKEND=xvfb \
BOTSCREEN_XVFB_BIN=/data/home/xserver-build/hw/vfb/Xvfb \
python -m botscreen
```

| 维度 | KasmVNC 后端 | X.Org Xvfb 后端（当前） |
|---|---|---|
| X server 来源 | KasmVNC 自带的 Xvnc（fork 的 TigerVNC） | **上游 xorg/xserver**，自己编译 |
| 色深 | 32 位（有 ARGB visual，dock 可透明圆角） | **只能 24 位**（Xvfb 不支持 x32 screen） |
| 推流 | Xvnc 内嵌 `-websocketPort`，自带 HTML5 前端 | **x11vnc → websockify → noVNC**，每层可独立替换 |
| RFB 端口 | 无（只有 wsTCP） | 5950+N，仅 loopback |
| 前端 | KasmVNC www（`isInsideKasmVDI` 有坑） | noVNC（标准，`path` 用绝对路径） |
| 依赖 | kasmvncserver 包 | meson/ninja + 源码树 + x11vnc + websockify + novnc |

`GET /api/screens/{bot}` 现在带 `x_backend` 与 `rfb_port`。

**已修复**：网关代理接管页（`/vnc/{bot}/vnc.html?path=%2Fvnc%2F{bot}%2Fwebsockify`）可以直连出画面。

根因不是上游，而是网关自己的握手回包：`Sec-WebSocket-Protocol` 在**客户端没请求**时不能出现在响应里，
浏览器会直接判非法（`Response must not include 'Sec-WebSocket-Protocol' header if not present in request`）。
现在只在客户端确实请求时才回：

```python
requested = websocket.headers.get("sec-websocket-protocol")
subproto = requested.split(",")[0].strip() if requested else None
await websocket.accept(subprotocol=subproto)
```

另外 noVNC 的 `path` 语义和 KasmVNC 不同（noVNC 按**页面目录**解析相对路径），必须传绝对路径
`%2Fvnc%2F{bot}%2Fwebsockify`，否则会拼成 `/vnc/bot/vnc/bot/websockify`。

## 9.1 与 Hermes `tools/bot_desktop` 的对照

| 维度 | Hermes | 本实现 |
|---|---|---|
| X server | TigerVNC，Unix socket 0600，`-rfbport -1` | KasmVNC，TCP `127.0.0.1:610N` |
| 桌面 | 完整 Xfce，1440×900，空闲 ~220 MB | 极简 openbox，1280×720，空闲 20.6 MB |
| 空闲 | **stop**（杀进程组），唤醒=冷启 | **cgroup freeze**，窗口原样保留，唤醒 11 ms |
| 输入 | cua-driver（独立 MCP 驱动） | xdotool + xclip |
| 互斥 | lease 落盘 + fcntl + epoch + fail-closed | 已对齐（本版补上） |
| 截图门控 | 人类持有时拒绝 | 已对齐（`blocked: screenshot`） |
| 内存门禁 | `min_free_memory_mb` 默认 1536，取两值最小值 | 已对齐（`BOTSCREEN_MIN_FREE_MB` 默认 1024） |
| RFB 门控 | 字节级状态机逐消息丢弃非持有者输入 | 未做（WS 层鉴权；「只读旁观 + Agent 操作」场景需要补） |
| 多机 | placement：gateway / 沙箱内 | 单机 |

我们刻意与 Hermes 不同的两点：**没有用 Xfce**（30 屏 × 220 MB 放不下）、**用 freeze 不用 stop**
（Bot 要长期保持登录态/表单/标签页）。

## 9.2 部署到 instabox 云沙箱（bread）

已在 `bread`（instabox，Debian 13 trixie，4 vCPU / 8 GB，`/data` 20 GB）实测跑通，32/32 回归通过。

```bash
# 1) 上传（本地打包，排除 .venv）
tar --exclude=.venv --exclude=__pycache__ -czf /tmp/bs.tgz \
    botscreen web deploy tools requirements.txt install.sh BOTSCREEN.md
instabox cp /tmp/bs.tgz bread:/data/home/bs.tgz
instabox exec bread -- 'mkdir -p /data/home/botscreen-app && tar xzf /data/home/bs.tgz -C /data/home/botscreen-app'

# 2) 安装（Debian 走 kasmvncserver_debian_trixie_*.deb；/data 顶层 root-only，数据目录放 HOME 下）
instabox exec bread -- 'cd /data/home/botscreen-app && \
  BOTSCREEN_DATA_ROOT=/data/home/botscreen-data BOTSCREEN_BOTS=bot_01,bot_02,bot_03 ./install.sh'

# 3) 启动（后台）
instabox exec --background bread -- 'cd /data/home/botscreen-app && \
  BOTSCREEN_DATA_ROOT=/data/home/botscreen-data BOTSCREEN_PORT=6200 .venv/bin/python -m botscreen'

# 4) 发布控制台
instabox port publish bread 6200 --private --name botscreen
```

沙箱环境的三点差异：

| 项 | 结果 |
|---|---|
| cgroup v2 freeze | **可用**（内核 6.18，`cgroup.events` 显示 `frozen 1`，3 s CPU 增量 0） |
| zram | 不可用（容器内 `swapon` 缺失 / 无权限），`reclaim` 也就没有 swap 可换出，冻结后内存靠内核自身回收 |
| `/data` 顶层 | `root:root 755`，普通用户不可写 → 代码与数据都放 `$HOME`（`/data/home`） |

实测（bread）：冷启动一屏 0.6 s、截屏 25 ms / 18 KB、freeze 12 ms、thaw 10 ms、冻结 3 s CPU 0 µs。
网关是 `exec --background` 起的进程，沙箱重启后需重跑；沙箱默认 30 分钟 idle 自动暂停（`create` 时用
`--auto-suspend 0` 可关，已存在的沙箱需要重建或改 `autoSuspend`）。

桌面壳在 bread 上额外需要：`xfwm4 xfdesktop4 xfconf dbus-x11 tint2 picom pcmanfm xterm fonts-noto-cjk`
（`install.sh` 已包含）。实测一张带完整桌面的屏 ≈ 9 个进程 / 75 MB，冻结后回到 10 MB 级别。

公网访问：`port publish` 给的 URL 需要带 `?_token=...` 先换 `__Host-instabox_port_auth` cookie，
之后 HTTP 与 **WSS** 都能直接走（WSS 也可在 query 里直接带 `_token`），接管链路完整可用。

## 10. 已知限制

- 单机版；跨机调度需要把 Worker 抽象成远程执行器（当前代码已把生命周期收敛在 `ScreenWorker`）。
- 冻结期间不能截图（X server 已被内核暂停），控制台对 `FROZEN` 屏沿用最后一帧。
- `screen_type_text` 依赖剪贴板：目标应用需支持 `ctrl+v`（浏览器/GTK/Qt 均可），终端类请用 `shift+Insert`。
- 内嵌实时操控受 KasmVNC VDI 检测限制，实时接管走顶层窗口（控制台一键打开）。