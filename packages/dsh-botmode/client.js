window.__ModuleLoader__.load({
  id: '@local/dsh-botmode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useMemo, useEffect, useRef, useSyncExternalStore } = React

    const PANEL_ID = 'botmode'
    const NS = 'botmode'
    const ROSTER_KEY = 'dsh.botmode.roster.v1'
    /* Team roster written on the Host inside the team workspace, so a Bot can
       add teammates that every browser picks up on its next load. */
    const HOST_ROSTER_FILE = 'bot-team.json'

    const COLORS = ['#4d6bfe', '#2f9e6e', '#d97706', '#c2410c', '#7c3aed', '#0e7490', '#be185d', '#4b5563']

    const DICT = {
      en: {
        'meta.title': 'Bot mode',
        'mode.label': 'Work mode',
        'mode.harness': 'Harness',
        'mode.bot': 'Bot',
        'mode.toBots': 'Switch to Bot mode',
        'mode.toHarness': 'Switch to Harness mode',
        'mode.currentBots': 'Current mode: Bot',
        'mode.currentHarness': 'Current mode: Harness',
        'page.eyebrow': 'Bot mode',
        'page.title': 'Bots',
        'page.subtitle': 'Named, long-lived assistants. Each Bot owns a workspace folder named after it — its persona lives there, and the team board connects every Bot.',
        'page.new': 'New bot',
        'page.empty.title': 'No Bots yet',
        'page.empty.body': 'A Bot is its own workspace plus a chat. Creating one writes its persona into AGENTS.md there; the team board lets every Bot on this machine leave messages for the others.',
        'page.empty.cta': 'Create the first Bot',
        'pane.bots': 'Bots',
        'pane.groups': 'Group chats',
        'pane.newGroup': 'New',
        'card.noPreview': 'No messages yet',
        'group.createTitle': 'New group chat',
        'group.editTitle': 'Group settings',
        'group.hint': 'Every member answers in the group; each reply is posted in the shared transcript.',
        'group.name': 'Name',
        'group.namePlaceholder': 'e.g. Research desk',
        'group.members': 'Members',
        'group.create': 'Create group',
        'group.delete': 'Delete group',
        'group.empty': 'No messages in the group yet.',
        'group.emptyPreview': 'No messages yet',
        'group.none': 'No group chat yet',
        'group.placeholder': 'Message the group…',
        'group.send': 'Send',
        'group.you': 'You',
        'group.membersCount': '{n} Bots',
        'group.noMembers': 'Add at least two Bots first.',
        'group.needName': 'Name the group first.',
        'group.needMembers': 'Pick at least two Bots.',
        'chat.working': 'Working',
        'chat.idle': 'Idle',
        'chat.tab': 'Chat',
        'chat.detail': 'Details',
        'chat.empty': 'Say something to {name}.',
        'chat.placeholder': 'Message {name}…',
        'chat.send': 'Send',
        'chat.stop': 'Stop',
        'chat.older': 'Load older messages',
        'pane.title': 'Bots',
        'pane.search': 'Search Bots',
        'pane.empty': 'No matching Bot',
        'detail.workspace': 'Workspace',
        'detail.instructions': 'Standing instructions',
        'detail.sessions': 'Sessions in this workspace',
        'detail.noSessions': 'No session yet',
        'card.open': 'Open chat',
        'card.edit': 'Edit',
        'card.delete': 'Delete',
        'card.confirm': 'Delete this Bot? Its chat stays in Harness mode.',
        'card.cancel': 'Cancel',
        'card.ready': 'Chat ready',
        'card.working': 'Working',
        'card.missing': 'Chat missing',
        'card.workspace': 'Workspace',
        'card.migrate': 'Create workspace',
        'card.migrating': 'Creating…',
        'form.createTitle': 'New Bot',
        'form.editTitle': 'Edit Bot',
        'form.name': 'Name',
        'form.namePlaceholder': 'e.g. Researcher',
        'form.role': 'Role',
        'form.rolePlaceholder': 'e.g. Research and sources',
        'form.instructions': 'Standing instructions',
        'form.instructionsPlaceholder': 'What this Bot owns, how it should work, what it must not do.',
        'form.color': 'Colour',
        'form.hint': 'Creating a Bot gives it its own workspace folder named after it. Its persona and standing instructions are written into AGENTS.md, SOUL.md and .dsh/skills/team/SKILL.md there.',
        'form.cancel': 'Cancel',
        'form.create': 'Create Bot',
        'form.save': 'Save',
        'form.busy': 'Working…',
        'brief.title': 'Brief the team',
        'brief.body': 'Send one message to several Bots at once. Each answer arrives in that Bot’s own chat.',
        'brief.placeholder': 'What should the team look at?',
        'brief.send': 'Send brief',
        'brief.sent': 'Sent to {n} Bot(s). Their answers arrive in their chats.',
        'brief.pick': 'Pick at least one Bot.',
        'brief.needText': 'Write the brief first.',
        'foot.hint': 'Harness mode is the normal session list and conversation. Opening a Bot chat takes you there; the Bots row brings you back.',
        'foot.back': 'Back to Harness',
        'err.create': 'Could not create the Bot: {msg}',
        'err.update': 'Could not update the Bot: {msg}',
        'err.brief': 'Could not send the brief: {msg}',
        'err.session': 'This Bot has no chat session any more.',
      },
      zh: {
        'meta.title': 'Bot 模式',
        'mode.label': '工作模式',
        'mode.harness': 'Harness',
        'mode.bot': 'Bot',
        'mode.toBots': '切换到 Bot 模式',
        'mode.toHarness': '切换到 Harness 模式',
        'mode.currentBots': '当前模式：Bot',
        'mode.currentHarness': '当前模式：Harness',
        'page.eyebrow': 'Bot 模式',
        'page.title': 'Bot 团队',
        'page.subtitle': '有名字、长期存在的助手。每个 Bot 拥有一个以自己命名的工作区，人格写在里面；所有 Bot 通过团队留言板互通。',
        'page.new': '新建 Bot',
        'page.empty.title': '还没有 Bot',
        'page.empty.body': '每个 Bot 是一个独立工作区加一条对话。创建时会把人格写进工作区的 AGENTS.md；所有 Bot 通过团队留言板互相留话。',
        'page.empty.cta': '创建第一个 Bot',
        'pane.bots': 'Bot',
        'pane.groups': '群聊',
        'pane.newGroup': '新建',
        'card.noPreview': '还没有消息',
        'group.createTitle': '新建群聊',
        'group.editTitle': '群聊设置',
        'group.hint': '每位成员都会在群里回复，所有消息落在同一个群记录里。',
        'group.name': '群名称',
        'group.namePlaceholder': '例如：调研小组',
        'group.members': '成员',
        'group.create': '创建群聊',
        'group.delete': '删除群聊',
        'group.empty': '群里还没有消息。',
        'group.emptyPreview': '还没有消息',
        'group.none': '还没有群聊',
        'group.placeholder': '发到群里…',
        'group.send': '发送',
        'group.you': '你',
        'group.membersCount': '{n} 个 Bot',
        'group.noMembers': '先至少加两个 Bot。',
        'group.needName': '先给群起个名字。',
        'group.needMembers': '至少选两个 Bot。',
        'chat.working': '工作中',
        'chat.idle': '空闲',
        'chat.tab': '对话',
        'chat.detail': '详情',
        'chat.empty': '跟 {name} 说点什么。',
        'chat.placeholder': '发消息给 {name}…',
        'chat.send': '发送',
        'chat.stop': '停止',
        'chat.older': '加载更早的消息',
        'pane.title': 'Bot 会话',
        'pane.search': '搜索 Bot',
        'pane.empty': '没有匹配的 Bot',
        'detail.workspace': '工作区',
        'detail.instructions': '常驻指令',
        'detail.sessions': '这个工作区的会话',
        'detail.noSessions': '还没有会话',
        'card.open': '打开对话',
        'card.edit': '编辑',
        'card.delete': '删除',
        'card.confirm': '删除这个 Bot？它的对话会留在 Harness 模式里。',
        'card.cancel': '取消',
        'card.ready': '对话就绪',
        'card.working': '工作中',
        'card.missing': '对话已丢失',
        'card.workspace': '工作区',
        'card.migrate': '建立独立工作区',
        'card.migrating': '建立中…',
        'form.createTitle': '新建 Bot',
        'form.editTitle': '编辑 Bot',
        'form.name': '名字',
        'form.namePlaceholder': '例如：研究员',
        'form.role': '职责',
        'form.rolePlaceholder': '例如：调研与查资料',
        'form.instructions': '常驻指令',
        'form.instructionsPlaceholder': '这个 Bot 负责什么、怎么工作、不能做什么。',
        'form.color': '颜色',
        'form.hint': '创建后会为它建立一个同名的工作区文件夹；人格、职责与常驻指令会写进里面的 AGENTS.md、SOUL.md 和 .dsh/skills/team/SKILL.md。',
        'form.cancel': '取消',
        'form.create': '创建 Bot',
        'form.save': '保存',
        'form.busy': '处理中…',
        'brief.title': '给团队派活',
        'brief.body': '把一条消息同时发给多个 Bot。每只 Bot 的答复会出现在它自己的对话里。',
        'brief.placeholder': '团队要一起看什么？',
        'brief.send': '发送',
        'brief.sent': '已发给 {n} 个 Bot，答复会出现在各自的对话里。',
        'brief.pick': '至少选择一个 Bot。',
        'brief.needText': '先写内容。',
        'foot.hint': 'Harness 模式就是普通的会话列表与对话。打开某个 Bot 的对话会回到那里；点侧栏的 Bots 行就能回来。',
        'foot.back': '回到 Harness',
        'err.create': '创建 Bot 失败：{msg}',
        'err.update': '更新 Bot 失败：{msg}',
        'err.brief': '发送失败：{msg}',
        'err.session': '这个 Bot 已经没有对应的会话了。',
      },
    }

    function pickDict(lang) {
      const id = String(lang || '').toLowerCase()
      return id.startsWith('zh') ? DICT.zh : DICT.en
    }

    function interpolate(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (all, key) => (vars && key in vars ? String(vars[key]) : all))
    }

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function readRoster() {
      try {
        const raw = window.localStorage.getItem(ROSTER_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        if (!Array.isArray(parsed)) return []
        return parsed.filter(bot => bot && typeof bot.id === 'string' && typeof bot.name === 'string'
          && typeof bot.sessionId === 'string')
      } catch (_error) {
        return []
      }
    }

    function writeRoster(list) {
      try {
        window.localStorage.setItem(ROSTER_KEY, JSON.stringify(list))
      } catch (_error) {
        /* storage full or unavailable: the in-memory roster still works this session */
      }
    }

    function newId() {
      const cryptoObj = window.crypto
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
      return `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    function initialOf(name) {
      const text = String(name || '').trim()
      return text === '' ? '?' : Array.from(text)[0].toUpperCase()
    }

    function setupInChat(draft, team, lang, update = false) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      const roster = team.length > 0 ? team.map(member => `- ${member.name}${member.role ? ` — ${member.role}` : ''}`).join('\n') : (zh ? '- （暂无其他 Bot）' : '- (no other Bots yet)')
      if (zh) {
        return `[Bot 初始化] 你是 ${draft.name}${draft.role ? `，职责：${draft.role}` : ''}。\n\n常驻指令：\n${draft.instructions || '（暂无）'}\n\n团队：\n${roster}\n\n请先做一件事：在**当前工作区**里建立你自己的设定文件（不存在才写，已存在就更新）：\n1. AGENTS.md：人格 + 职责 + 常驻指令 + 团队规则\n2. SOUL.md：与 AGENTS.md 相同的人格内容\n3. TEAM.md：团队成员名单\n4. .dsh/skills/team/SKILL.md：说明用团队留言板与队友沟通（读留言、发留言）\n\n然后用一句短话介绍自己，等指令。${update ? '（这是一次档案更新，不要重复自我介绍。）' : ''}`
      }
      return `[Bot setup] You are ${draft.name}${draft.role ? `, role: ${draft.role}` : ''}.\n\nStanding instructions:\n${draft.instructions || '(none)'}\n\nTeam:\n${roster}\n\nFirst, write your own setup files in **this workspace** (create them if missing, update them if present):\n1. AGENTS.md: persona + role + standing instructions + team rules\n2. SOUL.md: the same persona\n3. TEAM.md: the team roster\n4. .dsh/skills/team/SKILL.md: how to talk to teammates on the team board\n\nThen introduce yourself in one short sentence and wait.${update ? ' (This is a profile update; skip the introduction.)' : ''}`
    }

    function kickoff(name, lang) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      return zh
        ? `[Bot 初始化] 你是 ${name}。你的职责、常驻指令和团队规则都写在当前工作区的 AGENTS.md 与 .dsh/skills/team/SKILL.md 里。先用一句短话介绍自己，然后等指令。`
        : `[Bot setup] You are ${name}. Your role, standing instructions and the team rules are in AGENTS.md and .dsh/skills/team/SKILL.md in this workspace. Introduce yourself in one short sentence, then wait.`
    }

    function profileUpdate(name, role, instructions, lang) {
      const zh = String(lang || '').toLowerCase().startsWith('zh')
      return zh
        ? `[你的档案已更新] 你现在是 ${name}。AGENTS.md 已写成最新版本，从现在起按它工作；如果这次改动对外有影响，用一句话说明。`
        : `[Your profile was updated] You are now ${name}. AGENTS.md holds the latest version; work from it from now on. If the change matters to the user, say so in one line.`
    }

    const CSS = `
      .bm-switch { display: inline-flex; align-items: center; gap: 2px; padding: 2px; box-sizing: border-box;
        height: 38px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); flex: none; }
      .bm-switch button { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 12px; line-height: 16px; padding: 0 8px; height: 30px; border-radius: 6px; cursor: pointer;
        white-space: nowrap; }
      .bm-switch button[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary);
        box-shadow: inset 0 0 0 0.5px var(--dsw-alias-button-ghost-active-border); }
      .bm-switch button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-switch button[data-active='true']:hover { background: var(--dsw-alias-button-ghost-active-hover); }
      .bm-rail { appearance: none; width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center;
        justify-content: center; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); cursor: pointer; }
      .bm-rail:hover { background: var(--dsw-alias-button-floating-hover); }
      .bm-page { box-sizing: border-box; height: 100%; overflow: auto; padding: 40px 32px 64px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
      .bm-inner { max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
      .bm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .bm-eyebrow { font-size: 12px; line-height: 16px; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary); margin-bottom: 6px; }
      .bm-title { margin: 0; font-size: 26px; line-height: 34px; font-weight: 600; }
      .bm-sub { margin: 6px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); max-width: 560px; }
      .bm-btn { appearance: none; font: inherit; font-size: 13px; line-height: 18px; height: 34px; padding: 0 14px;
        border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l3); cursor: pointer;
        background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); }
      .bm-btn:hover { background: var(--dsw-alias-button-floating-hover); }
      .bm-btn.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); border-color: transparent; }
      .bm-btn.primary:hover { background: var(--dsw-alias-button-primary-hover); color: var(--dsw-alias-label-primary-inverted); }
      .bm-btn.danger { color: var(--dsw-alias-label-error); }
      .bm-btn:disabled { opacity: 0.55; cursor: default; }
      .bm-btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
      .bm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
      .bm-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-card-fill); }
      .bm-card-top { display: flex; align-items: center; gap: 10px; }
      .bm-avatar { width: 36px; height: 36px; border-radius: 12px; display: inline-flex; align-items: center;
        justify-content: center; color: #fff; font-weight: 600; font-size: 15px; flex: none; }
      .bm-name { font-size: 14px; line-height: 20px; font-weight: 600; }
      .bm-role { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-chip { margin-left: auto; font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        color: var(--dsw-alias-label-secondary); border: 0.5px solid var(--dsw-alias-border-l3); white-space: nowrap; }
      .bm-form-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .bm-dir { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 18px; }
      .bm-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
      .bm-empty { border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg);
        padding: 28px 20px; text-align: center; background: var(--dsw-alias-bg-layer-1); }
      .bm-empty h2 { margin: 0 0 6px; font-size: 16px; line-height: 24px; }
      .bm-empty p { margin: 0 auto 14px; font-size: 13px; line-height: 20px; max-width: 480px;
        color: var(--dsw-alias-label-secondary); }
      .bm-form { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-card-fill); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
      .bm-form h2 { margin: 0; font-size: 16px; line-height: 24px; }
      .bm-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 16px;
        color: var(--dsw-alias-label-secondary); }
      .bm-input, .bm-area { font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-md); padding: 8px 10px; box-sizing: border-box; width: 100%; }
      .bm-input:focus, .bm-area:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-area { resize: vertical; min-height: 84px; }
      .bm-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .bm-swatches { display: flex; gap: 8px; flex-wrap: wrap; }
      .bm-swatch { width: 24px; height: 24px; border-radius: 8px; border: 2px solid transparent; cursor: pointer; padding: 0; }
      .bm-swatch[data-active='true'] { border-color: var(--dsw-alias-label-primary); }
      .bm-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .bm-error { font-size: 12px; line-height: 18px; padding: 8px 10px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-error); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l3); }
      .bm-ok { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bm-brief { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      .bm-brief h2 { margin: 0; font-size: 14px; line-height: 20px; }
      .bm-brief p { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .bm-picks { display: flex; flex-wrap: wrap; gap: 8px; }
      .bm-pick { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px;
        padding: 4px 10px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
      .bm-pick[data-on='true'] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-selected);
        background: var(--dsw-alias-button-ghost-active-fill); }


      .bm-section { display: flex; align-items: center; justify-content: space-between; gap: 6px;
        padding: 10px 6px 4px; font-size: 10px; line-height: 14px; letter-spacing: 0.04em;
        text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
      .bm-section-add { appearance: none; border: 0; background: transparent; font: inherit; font-size: 10px;
        color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 0 4px; }
      .bm-section-add:hover { color: var(--dsw-alias-label-primary); }
      .bm-frow { appearance: none; border: 0; background: transparent; font: inherit; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; gap: 9px; padding: 7px 6px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
      .bm-frow:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-frow[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-frow-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
      .bm-frow-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
      .bm-frow-name { font-size: 12px; line-height: 16px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-frow-time { margin-left: auto; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-tertiary); }
      .bm-frow-preview { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-unread { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-brand-primary); }
      .bm-msg-name { font-size: 10px; line-height: 14px; font-weight: 600; color: var(--dsw-alias-label-tertiary); margin-bottom: 3px; }
      .bm-page-split { display: flex; height: 100%; padding: 0; overflow: hidden; }
      .bm-pane { width: 296px; flex: none; box-sizing: border-box; display: flex; flex-direction: column;
        border-right: 0.5px solid var(--dsw-alias-border-l2); padding: 12px 8px; gap: 6px; overflow: hidden; }
      .bm-pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 6px; }
      .bm-pane-title { font-size: 13px; line-height: 18px; font-weight: 600; }
      .bm-search { font: inherit; font-size: 12px; line-height: 18px; box-sizing: border-box; width: 100%;
        padding: 6px 9px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
      .bm-search:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-groups { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 1px; }
      .bm-group { display: flex; flex-direction: column; }
      .bm-grow { appearance: none; border: 0; background: transparent; font: inherit; width: 100%; box-sizing: border-box;
        display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px; border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
      .bm-grow:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-grow[data-active='true'] { background: var(--dsw-alias-interactive-bg-hover); }
      .bm-avatar-sm { width: 22px; height: 22px; border-radius: 7px; font-size: 10px; }
      .bm-avatar-lg { width: 40px; height: 40px; border-radius: 13px; font-size: 16px; }
      .bm-grow-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .bm-grow-name { font-size: 12px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-grow-role { font-size: 11px; line-height: 14px; color: var(--dsw-alias-label-tertiary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-grow-count { margin-left: auto; font-size: 10px; line-height: 16px; min-width: 18px; text-align: center;
        border-radius: 999px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); }
      .bm-gsessions { display: flex; flex-direction: column; gap: 1px; padding: 1px 0 4px 28px; }
      .bm-srow { appearance: none; border: 0; background: transparent; font: inherit; display: flex; align-items: center;
        gap: 7px; height: 28px; padding: 0 6px; width: 100%; border-radius: var(--dsw-radius-md); cursor: pointer;
        color: var(--dsw-alias-label-secondary); text-align: left; }
      .bm-srow:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .bm-srow[data-primary='true'] { color: var(--dsw-alias-label-primary); }
      .bm-srow-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary); opacity: 0.5; }
      .bm-srow-dot[data-running='true'] { background: var(--dsw-alias-brand-primary); opacity: 1; }
      .bm-srow-title { font-size: 12px; line-height: 16px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bm-srow-time { font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-pane-foot { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 8px; display: flex; }
      .bm-pane-empty { padding: 12px 8px; }
      .bm-detail-col { flex: 1; min-width: 0; overflow: auto; padding: 28px 32px 48px; }
      .bm-detail { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
      .bm-dhead { display: flex; align-items: center; gap: 12px; }
      .bm-dhead-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .bm-name-lg { font-size: 18px; line-height: 24px; }
      .bm-dactions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .bm-confirm { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .bm-block { display: flex; flex-direction: column; gap: 6px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 14px; }
      .bm-block h3 { margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
        text-transform: uppercase; letter-spacing: 0.03em; }
      .bm-block p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
      .bm-slist { display: flex; flex-direction: column; gap: 2px; }
      .bm-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      .bm-detail-empty { max-width: 520px; margin: 48px auto; }

      .bm-chat { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; }
      .bm-chat-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); flex: none; }
      .bm-chat-title { display: flex; flex-direction: column; min-width: 0; }
      .bm-chat-title .bm-name { font-size: 13px; line-height: 18px; }
      .bm-chat-title .bm-role { font-size: 11px; line-height: 15px; }
      .bm-chat-status { margin-left: auto; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .bm-chat-status[data-running='true'] { color: var(--dsw-alias-brand-primary); }
      .bm-log { flex: 1; overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
      .bm-msg { max-width: 78%; font-size: 13px; line-height: 20px; white-space: pre-wrap; word-break: break-word;
        padding: 8px 11px; border-radius: var(--dsw-radius-md); }
      .bm-msg-user { align-self: flex-end; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-msg-bot { align-self: flex-start; background: var(--dsw-alias-card-fill); color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-msg-live { opacity: 0.85; }
      .bm-toolrow { align-self: flex-start; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
        padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); }
      .bm-toolrow[data-error='true'] { color: var(--dsw-alias-label-error); }
      .bm-live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 6px;
        background: var(--dsw-alias-brand-primary); animation: bm-pulse 1.2s ease-in-out infinite; }
      @keyframes bm-pulse { 0%,100% { opacity: 0.25 } 50% { opacity: 1 } }
      .bm-compose { flex: none; border-top: 0.5px solid var(--dsw-alias-border-l2); padding: 10px 12px 12px;
        display: flex; gap: 8px; align-items: flex-end; }
      .bm-compose textarea { flex: 1; resize: none; min-height: 34px; max-height: 160px; font: inherit; font-size: 13px;
        line-height: 20px; padding: 7px 10px; box-sizing: border-box; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-md); }
      .bm-compose textarea:focus { outline: none; border-color: var(--dsw-alias-border-selected); }
      .bm-chat-empty { margin: auto; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      .bm-chat-error { margin: 0 16px 8px; }
      .bm-chat-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
      .bm-chat-tabs button { appearance: none; border: 0; background: transparent; font: inherit; font-size: 11px;
        line-height: 16px; padding: 2px 8px; border-radius: 5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .bm-chat-tabs button[data-active='true'] { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); }
      .bm-foot { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 14px; display: flex;
        align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .bm-foot span { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); max-width: 620px; }
    `

    return {
      inject: ['slots', 'layout', 'locale', 'sessions', 'uiWorkspace', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const sessions = ctx.get('sessions')
        let workspaceStore
        try { workspaceStore = ctx.get('workspaces') } catch (_error) { workspaceStore = undefined }
        const locale = ctx.get('locale')
        const roster = createStore(readRoster())
        const GROUPS_KEY = 'dsh.botmode.groups.v1'
        const readGroups = () => {
          try {
            const raw = window.localStorage.getItem(GROUPS_KEY)
            const parsed = raw ? JSON.parse(raw) : []
            return Array.isArray(parsed) ? parsed.filter(group => group && typeof group.id === 'string' && Array.isArray(group.members)) : []
          } catch (_error) {
            return []
          }
        }
        const writeGroups = (list) => {
          try { window.localStorage.setItem(GROUPS_KEY, JSON.stringify(list)) } catch (_error) { /* memory only */ }
        }
        const groupStore = createStore(readGroups())
        const saveGroups = (next) => { writeGroups(next); groupStore.set(next) }
        const appendGroupMessage = (groupId, message) => {
          const next = groupStore.getSnapshot().map(group => (group.id === groupId
            ? { ...group, messages: [...(group.messages || []), message].slice(-300), lastAt: message.at }
            : group))
          saveGroups(next)
        }
        const markGroupSeen = (groupId) => {
          const next = groupStore.getSnapshot().map(group => (group.id === groupId ? { ...group, lastSeen: Date.now() } : group))
          saveGroups(next)
        }
        // Both spaces share one Host session list and one Workspace registry, and
        // neither has a filter API. This plugin therefore narrows the snapshots the
        // Harness sidebar reads: Harness mode shows only non-Bot entries, Bot mode
        // only Bot entries. The raw snapshots stay private to this plugin, so the Bot
        // pane always sees everything it owns.
        const workspaceSvc = ctx.get('workspaces')
        const rawSessionSnapshot = sessions.list.getSnapshot.bind(sessions.list)
        const rawWorkspaceSnapshot = workspaceSvc.list.getSnapshot.bind(workspaceSvc.list)
        const botDirs = () => roster.getSnapshot().map(bot => bot.dir).filter(dir => typeof dir === 'string' && dir !== '')
        const botSessionIds = () => new Set(roster.getSnapshot().map(bot => bot.sessionId).filter(Boolean))
        const underBotDir = (path) => {
          if (typeof path !== 'string' || path === '') return false
          return botDirs().some(dir => path === dir || path.startsWith(`${dir}/`))
        }
        let botSpace = false
        let sessionCache = { source: null, mode: null, value: null }
        let workspaceCache = { source: null, mode: null, value: null }
        const filteredSessionSnapshot = () => {
          const state = rawSessionSnapshot()
          if (sessionCache.source === state && sessionCache.mode === botSpace) return sessionCache.value
          const ids = state.ids.filter((id) => {
            const bot = underBotDir(state.byId[id]?.cwd) || botSessionIds().has(id)
            return botSpace ? bot : !bot
          })
          let value = state
          if (ids.length !== state.ids.length) {
            const byId = {}
            for (const id of ids) byId[id] = state.byId[id]
            value = { ...state, ids, byId }
          }
          sessionCache = { source: state, mode: botSpace, value }
          return value
        }
        const filteredWorkspaceSnapshot = () => {
          const state = rawWorkspaceSnapshot()
          if (workspaceCache.source === state && workspaceCache.mode === botSpace) return workspaceCache.value
          const items = (state.items || []).filter((row) => {
            const bot = underBotDir(row && row.path)
            return botSpace ? bot : !bot
          })
          const value = items.length === (state.items || []).length ? state : { ...state, items }
          workspaceCache = { source: state, mode: botSpace, value }
          return value
        }
        const sessionListeners = new Set()
        const workspaceListeners = new Set()
        const rawSessionSubscribe = sessions.list.subscribe.bind(sessions.list)
        const rawWorkspaceSubscribe = workspaceSvc.list.subscribe.bind(workspaceSvc.list)
        sessions.list.getSnapshot = filteredSessionSnapshot
        workspaceSvc.list.getSnapshot = filteredWorkspaceSnapshot
        sessions.list.subscribe = (listener) => {
          sessionListeners.add(listener)
          const off = rawSessionSubscribe(listener)
          return () => {
            sessionListeners.delete(listener)
            off()
          }
        }
        workspaceSvc.list.subscribe = (listener) => {
          workspaceListeners.add(listener)
          const off = rawWorkspaceSubscribe(listener)
          return () => {
            workspaceListeners.delete(listener)
            off()
          }
        }
        const refresh = () => {
          for (const listener of [...sessionListeners]) {
            try { listener() } catch (_error) { /* one consumer's failure must not stop the rest */ }
          }
          for (const listener of [...workspaceListeners]) {
            try { listener() } catch (_error) { /* as above */ }
          }
        }
        const inBotSpace = () => {
          const panel = ctx.layout.panelInfo.getSnapshot()
          return Boolean(panel && panel.activePanelId === PANEL_ID)
        }
        ctx.effect(() => {
          botSpace = inBotSpace()
          refresh()
          return ctx.layout.panelInfo.subscribe(() => {
            const next = inBotSpace()
            if (next === botSpace) return
            botSpace = next
            sessionCache = { source: null, mode: null, value: null }
            workspaceCache = { source: null, mode: null, value: null }
            refresh()
          })
        }, 'botmode: space filter')
        ctx.effect(() => () => {
          sessions.list.getSnapshot = rawSessionSnapshot
          sessions.list.subscribe = rawSessionSubscribe
          workspaceSvc.list.getSnapshot = rawWorkspaceSnapshot
          workspaceSvc.list.subscribe = rawWorkspaceSubscribe
          sessionListeners.clear()
          workspaceListeners.clear()
        }, 'botmode: space filter restore')

        const registerLocales = () => {
          const disposeEn = locale.register(NS, { en: {
            'mode.label': 'Work mode',
            'mode.harness': 'Harness',
            'mode.bot': 'Bot',
          } })
          const disposeZh = locale.register(NS, { zh: {
            'mode.label': '工作模式',
            'mode.harness': 'Harness',
            'mode.bot': 'Bot',
          } })
          return () => { disposeEn(); disposeZh() }
        }
        ctx.effect(registerLocales, 'botmode: dictionaries')

        /* Adopt roster entries the Host file carries and this browser does not
           yet have. The read needs one Session as filesystem authority, so the
           first Bot with a chat provides the anchor; a missing file, an
           unavailable Remote or a malformed record leaves the roster as it was.
           Seeding only appends: a local entry always wins. */
        const seedFromHost = async () => {
          try {
            const current = roster.getSnapshot()
            const anchor = current.find(bot => bot && bot.sessionId)
            if (!anchor) return
            let files
            try {
              const remote = ctx.get('remote')
              files = remote && remote.workspaceFiles
            } catch (_error) {
              return
            }
            if (!files || typeof files.read !== 'function') return
            const page = await files.read(anchor.sessionId, HOST_ROSTER_FILE, { offset: 1, limit: 200 })
            const body = page && 'value' in page ? (page.ok === false ? undefined : page.value) : page
            const text = typeof body === 'string' ? body : (body && body.text)
            if (typeof text !== 'string' || text.trim() === '') return
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch (_error) {
              return
            }
            const rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bots) ? parsed.bots : [])
            const fresh = roster.getSnapshot()
            const seen = new Set()
            for (const bot of fresh) {
              seen.add(bot.sessionId)
              seen.add(bot.name)
            }
            const merged = [...fresh]
            for (const row of rows) {
              if (!row || typeof row.name !== 'string' || typeof row.sessionId !== 'string') continue
              if (seen.has(row.sessionId) || seen.has(row.name)) continue
              merged.push({
                id: typeof row.id === 'string' && row.id !== '' ? row.id : newId(),
                name: row.name,
                role: typeof row.role === 'string' ? row.role : '',
                instructions: typeof row.instructions === 'string' ? row.instructions : '',
                color: typeof row.color === 'string' && row.color !== '' ? row.color : COLORS[0],
                sessionId: row.sessionId,
                createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
              })
              seen.add(row.sessionId)
              seen.add(row.name)
            }
            if (merged.length === fresh.length) return
            writeRoster(merged)
            roster.set(merged)
          } catch (_error) {
            /* seeding is best effort: the Bot page keeps working without it */
          }
        }

        ctx.effect(() => {
          const timer = setTimeout(() => { seedFromHost() }, 800)
          return () => { clearTimeout(timer) }
        }, 'botmode: host roster seed')

        const useLang = () => useSyncExternalStore(
          listener => locale.subscribe(listener),
          () => locale.getLocale(),
        )

        const useT = () => {
          const snapshot = useLang()
          const dict = useMemo(() => pickDict(snapshot && snapshot.active), [snapshot && snapshot.active])
          return useMemo(() => (key, vars) => interpolate(dict[key] ?? DICT.en[key] ?? key, vars), [dict])
        }

        const useMainPanel = () => useSyncExternalStore(
          listener => ctx.layout.panelInfo.subscribe(listener),
          () => ctx.layout.panelInfo.getSnapshot(),
        )

        const openBot = (bot) => {
          if (!bot.sessionId) return
          ctx.get('uiWorkspace').openSession(bot.sessionId)
        }

        const toBots = () => ctx.layout.selectPanel(PANEL_ID)
        const toHarness = () => ctx.layout.selectPanel(null)

        const promptBot = async (sessionId, text) => {
          const result = await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
            reference.binding.session.prompt([{ type: 'text', text }], 'queue')
          ))
          return result
        }

        const uiWorkspace = ctx.get('uiWorkspace')
        const workspaces = ctx.get('workspaces')
        const ROOT_KEY = 'dsh.botmode.root.v1'

        const dirnameOf = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(0, -1).join('/')
        const safeDirName = (name) => {
          const cleaned = String(name || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim()
          return cleaned === '' ? `bot-${Date.now().toString(36)}` : cleaned.slice(0, 60)
        }
        const ensureRoot = async () => {
          const saved = window.localStorage.getItem(ROOT_KEY)
          if (saved) return saved
          let root = ''
          try {
            const picked = await uiWorkspace.pickDirectory()
            if (picked) root = picked
          } catch (_error) { /* no native picker: derive below */ }
          if (root === '') {
            const items = rawWorkspaceSnapshot().items || []
            const plain = items.find(row => row && typeof row.path === 'string'
              && !row.path.includes('/DSH-Bots/') && !underBotDir(row.path))
            const base = plain ? dirnameOf(plain.path) : ''
            root = base === '' ? '' : `${base}/DSH-Bots`
          }
          root = root.replace(/\/(DSH-Bots)\/\1$/, '/$1')
          if (root === '') throw new Error('Choose a folder for the Bots first.')
          window.localStorage.setItem(ROOT_KEY, root)
          return root
        }
        const ensureRootDir = async (root) => {
          const parent = dirnameOf(root)
          const name = root.split('/').filter(Boolean).pop()
          if (parent === '' || name === undefined) return root
          try {
            await uiWorkspace.createDirectory(parent, name)
          } catch (error) {
            if (!/exist|EEXIST|already/i.test(String(error && error.message))) throw error
          }
          return root
        }
        const ensureDir = async (parent, name, full) => {
          try {
            return await uiWorkspace.createDirectory(parent, name)
          } catch (error) {
            if (/exist|EEXIST|already/i.test(String(error && error.message))) return full
            throw error
          }
        }
        const scaffold = async (sessionId, payload) => {
          try {
            const result = await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
              reference.binding.session.command(`/botmode scaffold ${JSON.stringify(payload)}`)
            ))
            return Boolean(result && result.ok && result.value && result.value.matched === true)
          } catch (_error) {
            return false
          }
        }
        const teamList = () => roster.getSnapshot().map(bot => ({ name: bot.name, role: bot.role || '' }))

        const createBot = async (draft, lang) => {
          const root = await ensureRootDir(await ensureRoot())
          const dirName = safeDirName(draft.name)
          const dir = await ensureDir(root, dirName, `${root}/${dirName}`)
          const workspace = await workspaces.create({ path: dir })
          try {
            await workspaces.rename(workspace.workspaceId, draft.name)
          } catch (_error) { /* the title falls back to the folder name */ }
          const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
          await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
            reference.binding.session.rename(draft.name)
          ))
          const scaffolded = await scaffold(sessionId, {
            name: draft.name,
            role: draft.role,
            instructions: draft.instructions,
            color: draft.color,
            team: teamList(),
          })
          await promptBot(sessionId, scaffolded
            ? kickoff(draft.name, lang)
            : setupInChat(draft, teamList(), lang))
          const bot = {
            id: newId(),
            name: draft.name,
            role: draft.role,
            instructions: draft.instructions,
            color: draft.color,
            sessionId,
            workspaceId: workspace.workspaceId,
            dir,
            createdAt: Date.now(),
          }
          const next = [...roster.getSnapshot(), bot]
          writeRoster(next)
          roster.set(next)
          return bot
        }

        const updateBot = async (bot, draft, lang) => {
          const next = roster.getSnapshot().map(item => (item.id === bot.id ? { ...item, ...draft } : item))
          writeRoster(next)
          roster.set(next)
          if (bot.sessionId) {
            await sessions.using(bot.sessionId, { source: 'botmode' }, (reference) => (
              reference.binding.session.rename(draft.name)
            ))
            const scaffolded = await scaffold(bot.sessionId, {
              name: draft.name,
              role: draft.role,
              instructions: draft.instructions,
              color: draft.color,
              team: teamList().filter(member => member.name !== draft.name),
            })
            if (!scaffolded) await promptBot(bot.sessionId, setupInChat(draft, teamList().filter(member => member.name !== draft.name), lang, true))
            if (bot.workspaceId && draft.name !== bot.name) {
              try {
                await workspaces.rename(bot.workspaceId, draft.name)
              } catch (_error) { /* keep the old workspace title */ }
            }
            await promptBot(bot.sessionId, profileUpdate(draft.name, draft.role, draft.instructions, lang))
          }
        }

        const deleteBot = (bot) => {
          const next = roster.getSnapshot().filter(item => item.id !== bot.id)
          writeRoster(next)
          roster.set(next)
        }

        const migrateBot = async (bot, lang) => {
          const root = await ensureRootDir(await ensureRoot())
          const dirName = safeDirName(bot.name)
          const dir = await ensureDir(root, dirName, `${root}/${dirName}`)
          const workspace = await workspaces.create({ path: dir })
          try {
            await workspaces.rename(workspace.workspaceId, bot.name)
          } catch (_error) { /* the title falls back to the folder name */ }
          const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
          await sessions.using(sessionId, { source: 'botmode' }, (reference) => (
            reference.binding.session.rename(bot.name)
          ))
          const team = teamList().filter(member => member.name !== bot.name)
          const scaffolded = await scaffold(sessionId, {
            name: bot.name, role: bot.role, instructions: bot.instructions, color: bot.color, team,
          })
          await promptBot(sessionId, scaffolded ? kickoff(bot.name, lang) : setupInChat(bot, team, lang))
          const next = roster.getSnapshot().map(item => (item.id === bot.id
            ? { ...item, sessionId, workspaceId: workspace.workspaceId, dir }
            : item))
          writeRoster(next)
          roster.set(next)
        }

        const sessionOf = (state, bot) => (state && state.byId ? state.byId[bot.sessionId] : undefined)

        function BotForm(props) {
          const t = useT()
          const [draft, setDraft] = useState(props.initial)
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const submit = async (event) => {
            event.preventDefault()
            if (busy) return
            const name = String(draft.name || '').trim()
            if (name === '') return
            setBusy(true)
            setError('')
            try {
              const value = { ...draft, name }
              if (props.mode === 'create') await createBot(value, props.lang)
              else await updateBot(props.bot, value, props.lang)
              props.onDone()
            } catch (failure) {
              setError(interpolate(t(props.mode === 'create' ? 'err.create' : 'err.update'), {
                msg: failure && failure.message ? failure.message : String(failure),
              }))
            } finally {
              setBusy(false)
            }
          }
          return h('form', { className: 'bm-form', onSubmit: submit },
            h('h2', null, t(props.mode === 'create' ? 'form.createTitle' : 'form.editTitle')),
            props.mode === 'create' ? h('p', { className: 'bm-form-hint' }, t('form.hint')) : null,
            h('div', { className: 'bm-row' },
              h('label', { className: 'bm-label' }, t('form.name'),
                h('input', {
                  className: 'bm-input', value: draft.name, autoFocus: true,
                  placeholder: t('form.namePlaceholder'),
                  onChange: event => setDraft({ ...draft, name: event.target.value }),
                })),
              h('label', { className: 'bm-label' }, t('form.role'),
                h('input', {
                  className: 'bm-input', value: draft.role,
                  placeholder: t('form.rolePlaceholder'),
                  onChange: event => setDraft({ ...draft, role: event.target.value }),
                }))),
            h('label', { className: 'bm-label' }, t('form.instructions'),
              h('textarea', {
                className: 'bm-area', value: draft.instructions, rows: 4,
                placeholder: t('form.instructionsPlaceholder'),
                onChange: event => setDraft({ ...draft, instructions: event.target.value }),
              })),
            h('div', { className: 'bm-label' }, t('form.color'),
              h('div', { className: 'bm-swatches' }, COLORS.map(color => h('button', {
                key: color, type: 'button', className: 'bm-swatch', title: color,
                style: { background: color }, 'data-active': draft.color === color,
                onClick: () => setDraft({ ...draft, color }),
              })))),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              h('button', { type: 'button', className: 'bm-btn', onClick: props.onCancel }, t('form.cancel')),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: busy || String(draft.name).trim() === '' },
                busy ? t('form.busy') : t(props.mode === 'create' ? 'form.create' : 'form.save'))),
          )
        }

        function BriefBox(props) {
          const t = useT()
          const [text, setText] = useState('')
          const [picked, setPicked] = useState([])
          const [busy, setBusy] = useState(false)
          const [notice, setNotice] = useState('')
          const toggle = (id) => setPicked(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
          const send = async () => {
            if (busy) return
            if (String(text).trim() === '') { setNotice(t('brief.needText')); return }
            const targets = props.bots.filter(bot => picked.includes(bot.id) && bot.sessionId)
            if (targets.length === 0) { setNotice(t('brief.pick')); return }
            setBusy(true)
            setNotice('')
            try {
              for (const bot of targets) {
                await promptBot(bot.sessionId, `[Team brief from the user] ${String(text).trim()}`)
              }
              setText('')
              setNotice(t('brief.sent', { n: targets.length }))
            } catch (failure) {
              setNotice(interpolate(t('err.brief'), { msg: failure && failure.message ? failure.message : String(failure) }))
            } finally {
              setBusy(false)
            }
          }
          return h('section', { className: 'bm-brief' },
            h('h2', null, t('brief.title')),
            h('p', null, t('brief.body')),
            h('div', { className: 'bm-picks' }, props.bots.map(bot => h('label', {
              key: bot.id, className: 'bm-pick', 'data-on': picked.includes(bot.id),
            },
              h('input', {
                type: 'checkbox', checked: picked.includes(bot.id),
                onChange: () => toggle(bot.id),
              }),
              bot.name))),
            h('textarea', {
              className: 'bm-area', rows: 3, value: text, placeholder: t('brief.placeholder'),
              onChange: event => setText(event.target.value),
            }),
            h('div', { className: 'bm-form-actions' },
              notice ? h('span', { className: 'bm-ok', style: { marginRight: 'auto' } }, notice) : null,
              h('button', { type: 'button', className: 'bm-btn primary', disabled: busy, onClick: send },
                busy ? t('form.busy') : t('brief.send'))),
          )
        }

        function BotCard(props) {
          const t = useT()
          const [confirming, setConfirming] = useState(false)
          const [migrating, setMigrating] = useState(false)
          const bot = props.bot
          const migrate = async () => {
            if (migrating) return
            setMigrating(true)
            try {
              await props.onMigrate(bot)
            } catch (_error) { /* the card keeps its old record on failure */ } finally {
              setMigrating(false)
            }
          }
          const summary = props.summary
          return h('article', { className: 'bm-card' },
            h('div', { className: 'bm-card-top' },
              h('span', { className: 'bm-avatar', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('div', null,
                h('div', { className: 'bm-name' }, bot.name),
                h('div', { className: 'bm-role' }, bot.role || '—')),
              h('span', { className: 'bm-chip' },
                !summary ? t('card.missing') : summary.running ? t('card.working') : t('card.ready'))),
            h('p', { className: 'bm-desc' }, bot.instructions || t('form.instructionsPlaceholder')),
            bot.dir
              ? h('div', { className: 'bm-dir', title: bot.dir }, `${t('card.workspace')} · ${bot.dir}`)
              : null,
            confirming
              ? h('div', { className: 'bm-card-actions' },
                h('span', { className: 'bm-ok', style: { width: '100%' } }, t('card.confirm')),
                h('button', { className: 'bm-btn small', onClick: () => setConfirming(false) }, t('card.cancel')),
                h('button', { className: 'bm-btn small danger', onClick: () => { props.onDelete(bot); setConfirming(false) } }, t('card.delete')))
              : h('div', { className: 'bm-card-actions' },
                !bot.dir
                  ? h('button', { className: 'bm-btn small', disabled: migrating, onClick: migrate },
                    migrating ? t('card.migrating') : t('card.migrate'))
                  : null,
                h('button', {
                  className: 'bm-btn small primary', disabled: !summary,
                  onClick: () => { if (summary) props.onOpen(bot) },
                }, t('card.open')),
                h('button', { className: 'bm-btn small', onClick: () => props.onEdit(bot) }, t('card.edit')),
                h('button', { className: 'bm-btn small danger', onClick: () => setConfirming(true) }, t('card.delete'))),
          )
        }

        function SessionRow(props) {
          const t = useT()
          const summary = props.summary
          const time = summary && typeof summary.updatedAt === 'number'
            ? new Date(summary.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''
          return h('button', {
            type: 'button',
            className: 'bm-srow',
            'data-primary': props.primary === true,
            onClick: props.onOpen,
          },
            h('span', { className: 'bm-srow-dot', 'data-running': Boolean(summary && summary.running) }),
            h('span', { className: 'bm-srow-title' }, props.title),
            time ? h('span', { className: 'bm-srow-time' }, time) : null)
        }

        function BotDetail(props) {
          const t = useT()
          const [confirming, setConfirming] = useState(false)
          const [migrating, setMigrating] = useState(false)
          const bot = props.bot
          const summary = props.summary
          const migrate = async () => {
            if (migrating) return
            setMigrating(true)
            try { await props.onMigrate(bot) } catch (_error) { /* keep the record */ } finally { setMigrating(false) }
          }
          return h('div', { className: 'bm-detail' },
            h('header', { className: 'bm-dhead' },
              h('span', { className: 'bm-avatar bm-avatar-lg', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('div', { className: 'bm-dhead-text' },
                h('div', { className: 'bm-name bm-name-lg' }, bot.name),
                h('div', { className: 'bm-role' }, bot.role || '—'),
                bot.dir ? h('div', { className: 'bm-dir', title: bot.dir }, `${t('detail.workspace')} · ${bot.dir}`) : null)),
            h('div', { className: 'bm-dactions' },
              h('button', { className: 'bm-btn primary', disabled: !summary, onClick: () => summary && props.onOpen(bot) }, t('card.open')),
              !bot.dir
                ? h('button', { className: 'bm-btn', disabled: migrating, onClick: migrate },
                  migrating ? t('card.migrating') : t('card.migrate'))
                : null,
              h('button', { className: 'bm-btn', onClick: () => props.onEdit(bot) }, t('card.edit')),
              confirming
                ? h('span', { className: 'bm-confirm' },
                  h('span', null, t('card.confirm')),
                  h('button', { className: 'bm-btn small', onClick: () => setConfirming(false) }, t('card.cancel')),
                  h('button', { className: 'bm-btn small danger', onClick: () => { props.onDelete(bot); setConfirming(false) } }, t('card.delete')))
                : h('button', { className: 'bm-btn danger', onClick: () => setConfirming(true) }, t('card.delete'))),
            h('section', { className: 'bm-block' },
              h('h3', null, t('detail.instructions')),
              h('p', null, bot.instructions || t('form.instructionsPlaceholder'))),
            h('section', { className: 'bm-block' },
              h('h3', null, t('detail.sessions')),
              props.sessions.length === 0
                ? h('p', { className: 'bm-muted' }, t('detail.noSessions'))
                : h('div', { className: 'bm-slist' }, props.sessions.map(row => h(SessionRow, {
                  key: row.id,
                  title: row.title,
                  summary: row.summary,
                  primary: row.primary,
                  onOpen: () => props.onOpenSession(row.id),
                })))),
            props.brief ? props.brief : null,
          )
        }

        function blocksText(blocks) {
          const parts = []
          for (const block of blocks || []) {
            if (!block || typeof block !== 'object') continue
            if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
            else if (block.type === 'tool-call') parts.push(`→ ${block.name || 'tool'}`)
            else if (block.type === 'image') parts.push('[image]')
            else if (block.type === 'file') parts.push(`[file${block.attachment && block.attachment.name ? `: ${block.attachment.name}` : ''}]`)
          }
          return parts.join('\n')
        }

        function chatRows(entries) {
          const rows = []
          let live = ''
          for (const entry of entries || []) {
            if (!entry || typeof entry !== 'object') continue
            if (entry.type === 'transient') {
              const chunk = entry.event && entry.event.data && entry.event.data.chunk
              if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') live += chunk.text
              continue
            }
            const event = entry.event
            if (!event || typeof event !== 'object') continue
            const data = event.data || {}
            if (event.type === 'user/message') {
              if (!data.source || data.source.kind !== 'user') continue
              const text = blocksText(data.content)
              if (text !== '') rows.push({ key: `u${event.seq}`, kind: 'user', text })
            } else if (event.type === 'assistant/message') {
              live = ''
              const message = data.message || {}
              const text = blocksText(message.content)
              if (text !== '') rows.push({ key: `a${event.seq}`, kind: 'assistant', text })
            } else if (event.type === 'tool/call') {
              rows.push({ key: `t${event.seq}`, kind: 'tool', text: data.name || 'tool' })
            } else if (event.type === 'tool/result') {
              rows.push({ key: `r${event.seq}`, kind: 'tool', text: `${data.message && data.message.name ? data.message.name : ''} done`, error: data.message && data.message.isError === true })
            }
          }
          return { rows, live }
        }

        function ChatPane(props) {
          const t = useT()
          const [tab, setTab] = useState('chat')
          const [text, setText] = useState('')
          const [error, setError] = useState('')
          const [busy, setBusy] = useState(false)
          const logRef = useRef(null)
          const reference = useMemo(() => {
            try {
              return sessions.retain(props.sessionId, { source: 'botmode.chat' })
            } catch (_failure) {
              return null
            }
          }, [props.sessionId])
          useEffect(() => () => { if (reference) reference.release() }, [reference])
          const binding = reference ? reference.binding : null
          const session = binding ? binding.session : null
          const snapshot = useSyncExternalStore(
            listener => (session ? session.subscribe(listener) : () => {}),
            () => (session ? session.getSnapshot() : { running: false, openState: 'error', hasMore: false }),
          )
          const events = useSyncExternalStore(
            listener => (binding ? binding.eventSource.subscribe(listener) : () => {}),
            () => (binding ? binding.eventSource.getSnapshot() : { entries: [], hasMore: false, revision: 0 }),
          )
          const { rows, live } = useMemo(() => chatRows(events.entries), [events])
          useEffect(() => {
            const node = logRef.current
            if (node) node.scrollTop = node.scrollHeight
          }, [events.revision, snapshot.running])
          useEffect(() => {
            if (props.onSeen) props.onSeen()
          }, [props.sessionId])
          useEffect(() => {
            if (!props.onActivity) return
            const last = [...rows].reverse().find(row => row.kind === 'assistant')
            if (last) props.onActivity(last.text)
          }, [events.revision])
          const send = async (event) => {
            event.preventDefault()
            const value = text.trim()
            if (value === '' || busy || session === null) return
            setBusy(true)
            setError('')
            try {
              const result = await session.prompt([{ type: 'text', text: value }], 'queue')
              if (result && result.ok === false) setError(result.error && result.error.message ? result.error.message : 'Prompt rejected')
              else setText('')
            } catch (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
            } finally {
              setBusy(false)
            }
          }
          const stop = async () => {
            if (session === null) return
            try { await session.cancel() } catch (_failure) { /* the turn may already be settling */ }
          }
          const head = h('header', { className: 'bm-chat-head' },
            h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: props.bot.color || COLORS[0] } }, initialOf(props.bot.name)),
            h('div', { className: 'bm-chat-title' },
              h('span', { className: 'bm-name' }, props.bot.name),
              h('span', { className: 'bm-role' }, props.bot.role || '—')),
            h('span', { className: 'bm-chat-status', 'data-running': Boolean(snapshot.running) },
              snapshot.running ? t('chat.working') : t('chat.idle')),
            h('div', { className: 'bm-chat-tabs' },
              h('button', { type: 'button', 'data-active': tab === 'chat', onClick: () => setTab('chat') }, t('chat.tab')),
              h('button', { type: 'button', 'data-active': tab === 'detail', onClick: () => setTab('detail') }, t('chat.detail'))))
          if (tab === 'detail') {
            return h('div', { className: 'bm-chat' }, head, h('div', { className: 'bm-detail-col' }, props.detail))
          }
          return h('div', { className: 'bm-chat' },
            head,
            h('div', { className: 'bm-log', ref: logRef },
              rows.length === 0 && live === '' && !snapshot.running
                ? h('div', { className: 'bm-chat-empty' }, t('chat.empty', { name: props.bot.name }))
                : null,
              snapshot.hasMore
                ? h('button', { className: 'bm-btn small', style: { alignSelf: 'center' }, onClick: () => { if (session) void session.loadOlder() } }, t('chat.older'))
                : null,
              rows.map(row => row.kind === 'user'
                ? h('div', { key: row.key, className: 'bm-msg bm-msg-user' }, row.text)
                : row.kind === 'tool'
                  ? h('div', { key: row.key, className: 'bm-toolrow', 'data-error': row.error === true }, row.text)
                  : h('div', { key: row.key, className: 'bm-msg bm-msg-bot' }, row.text)),
              live !== ''
                ? h('div', { className: 'bm-msg bm-msg-bot bm-msg-live' }, h('span', { className: 'bm-live-dot' }), live)
                : null),
            error ? h('div', { className: 'bm-error bm-chat-error' }, error) : null,
            h('form', { className: 'bm-compose', onSubmit: send },
              h('textarea', {
                value: text, rows: 1, placeholder: t('chat.placeholder', { name: props.bot.name }),
                onChange: event => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                },
              }),
              snapshot.running
                ? h('button', { type: 'button', className: 'bm-btn', onClick: stop }, t('chat.stop'))
                : h('button', { type: 'submit', className: 'bm-btn primary', disabled: busy || text.trim() === '' }, busy ? t('form.busy') : t('chat.send'))))
        }

        function GroupForm(props) {
          const t = useT()
          const [name, setName] = useState(props.group ? props.group.name : '')
          const [members, setMembers] = useState(props.group ? [...props.group.members] : [])
          const [error, setError] = useState('')
          const toggle = (id) => setMembers(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
          const submit = (event) => {
            event.preventDefault()
            const value = name.trim()
            if (value === '') { setError(t('group.needName')); return }
            if (members.length < 2) { setError(t('group.needMembers')); return }
            props.onSave({ name: value, members })
          }
          return h('form', { className: 'bm-form', onSubmit: submit },
            h('h2', null, t(props.group ? 'group.editTitle' : 'group.createTitle')),
            h('p', { className: 'bm-form-hint' }, t('group.hint')),
            h('label', { className: 'bm-label' }, t('group.name'),
              h('input', {
                className: 'bm-input', value: name, autoFocus: true, placeholder: t('group.namePlaceholder'),
                onChange: event => setName(event.target.value),
              })),
            h('div', { className: 'bm-label' }, t('group.members'),
              h('div', { className: 'bm-picks' }, props.bots.map(bot => h('label', {
                key: bot.id, className: 'bm-pick', 'data-on': members.includes(bot.id),
              },
                h('input', { type: 'checkbox', checked: members.includes(bot.id), onChange: () => toggle(bot.id) }),
                bot.name)))),
            error ? h('div', { className: 'bm-error' }, error) : null,
            h('div', { className: 'bm-form-actions' },
              props.group ? h('button', { type: 'button', className: 'bm-btn danger', onClick: props.onDelete }, t('group.delete')) : null,
              h('button', { type: 'button', className: 'bm-btn', onClick: props.onCancel }, t('form.cancel')),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: members.length < 2 || name.trim() === '' },
                t(props.group ? 'form.save' : 'group.create'))))
        }

        function GroupChat(props) {
          const t = useT()
          const [text, setText] = useState('')
          const [busy, setBusy] = useState(false)
          const [error, setError] = useState('')
          const logRef = useRef(null)
          const group = props.group
          const members = props.bots.filter(bot => group.members.includes(bot.id) && bot.sessionId)
          useEffect(() => { markGroupSeen(group.id) }, [group.id])
          useEffect(() => {
            const node = logRef.current
            if (node) node.scrollTop = node.scrollHeight
          }, [group.messages.length])
          const ask = (bot, prompt) => {
            let reference
            try {
              reference = sessions.retain(bot.sessionId, { source: 'botmode.group' })
            } catch (_failure) {
              return
            }
            const binding = reference.binding
            const base = binding.eventSource.getSnapshot().entries.length
            let lastText = ''
            let done = false
            let off = null
            const finish = () => {
              if (done) return
              done = true
              try { if (off) off() } catch (_failure) { /* already gone */ }
              try { reference.release() } catch (_failure) { /* already released */ }
              if (lastText.trim() !== '') {
                appendGroupMessage(group.id, { id: newId(), from: bot.id, name: bot.name, text: lastText.trim(), at: Date.now() })
                if (props.onPosted) props.onPosted(bot, lastText.trim())
              }
            }
            off = binding.eventSource.subscribe(() => {
              const entries = binding.eventSource.getSnapshot().entries
              let ended = false
              for (let index = base; index < entries.length; index += 1) {
                const entry = entries[index]
                if (!entry || entry.type !== 'event' || !entry.event) continue
                if (entry.event.type === 'assistant/message') {
                  const value = blocksText(entry.event.data && entry.event.data.message ? entry.event.data.message.content : [])
                  if (value !== '') lastText = value
                }
                if (entry.event.type === 'turn/end') ended = true
              }
              if (ended) finish()
            })
            window.setTimeout(finish, 180000)
            void binding.session.prompt([{ type: 'text', text: prompt }], 'queue').catch(() => {
              try { off() } catch (_failure) { /* already gone */ }
              try { reference.release() } catch (_failure) { /* already released */ }
            })
          }
          const send = (event) => {
            event.preventDefault()
            const value = text.trim()
            if (value === '' || busy) return
            if (members.length === 0) { setError(t('group.noMembers')); return }
            setBusy(true)
            setError('')
            const history = (group.messages || []).slice(-8).map(message => `${message.name}: ${message.text}`).join('\n')
            appendGroupMessage(group.id, { id: newId(), from: 'user', name: t('group.you'), text: value, at: Date.now() })
            for (const bot of members) {
              const prompt = [
                `[群聊「${group.name}」]`,
                history ? `最近的群消息：\n${history}` : '',
                `用户：${value}`,
                `你是 ${bot.name}${bot.role ? `（${bot.role}）` : ''}。在群里用简短的一段话回复，只说你负责的部分；不要代替其他成员说话。`,
              ].filter(Boolean).join('\n\n')
              ask(bot, prompt)
            }
            setText('')
            setBusy(false)
          }
          return h('div', { className: 'bm-chat' },
            h('header', { className: 'bm-chat-head' },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              h('div', { className: 'bm-chat-title' },
                h('span', { className: 'bm-name' }, group.name),
                h('span', { className: 'bm-role' }, t('group.membersCount', { n: members.length }))),
              h('div', { className: 'bm-chat-tabs' },
                h('button', { type: 'button', 'data-active': true }, t('chat.tab')),
                h('button', { type: 'button', onClick: props.onEdit }, t('chat.detail')))),
            h('div', { className: 'bm-log', ref: logRef },
              (group.messages || []).length === 0 ? h('div', { className: 'bm-chat-empty' }, t('group.empty')) : null,
              (group.messages || []).map(message => h('div', {
                key: message.id,
                className: `bm-msg ${message.from === 'user' ? 'bm-msg-user' : 'bm-msg-bot'}`,
              },
                message.from === 'user' ? null : h('div', { className: 'bm-msg-name' }, message.name),
                h('div', null, message.text)))),
            error ? h('div', { className: 'bm-error bm-chat-error' }, error) : null,
            h('form', { className: 'bm-compose', onSubmit: send },
              h('textarea', {
                value: text, rows: 1, placeholder: t('group.placeholder'),
                onChange: event => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) }
                },
              }),
              h('button', { type: 'submit', className: 'bm-btn primary', disabled: text.trim() === '' }, t('group.send'))))
        }

        function BotsPage() {
          const t = useT()
          const stored = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
          const groups = useSyncExternalStore(groupStore.subscribe, groupStore.getSnapshot)
          const list = useSyncExternalStore(
            listener => sessions.list.subscribe(listener),
            rawSessionSnapshot,
          )
          const workspaceList = useSyncExternalStore(
            listener => workspaceSvc.list.subscribe(listener),
            rawWorkspaceSnapshot,
          )
          const bots = stored.filter((bot) => {
            if (sessionOf(list, bot) === undefined) return false
            if (workspaceList === undefined || !Array.isArray(workspaceList.items)) return true
            if (!bot.workspaceId) return true
            return workspaceList.items.some(row => row && row.workspaceId === bot.workspaceId)
          })
          const lang = useLang()
          const activeLang = (lang && lang.active) || 'en'
          const [form, setForm] = useState(null)
          const [selection, setSelection] = useState(null)
          const [query, setQuery] = useState('')

          const patchBot = (id, patch) => {
            const next = roster.getSnapshot().map(bot => (bot.id === id ? { ...bot, ...patch } : bot))
            writeRoster(next)
            roster.set(next)
          }
          const botActivity = (bot) => (text) => {
            const current = roster.getSnapshot().find(item => item.id === bot.id)
            if (!current || current.lastText === text) return
            patchBot(bot.id, { lastText: text, lastAt: Date.now() })
          }
          const botSeen = (bot) => () => patchBot(bot.id, { lastSeen: Date.now() })

          const sessionRowsOf = (bot) => {
            const rows = list.ids
              .filter(id => id === bot.sessionId || (bot.dir && list.byId[id] && list.byId[id].cwd === bot.dir && list.byId[id].blank !== true))
              .map(id => ({
                id,
                title: list.byId[id] ? (list.byId[id].displayTitle || id) : id,
                summary: list.byId[id],
                primary: id === bot.sessionId,
              }))
            rows.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)
              || ((b.summary && b.summary.updatedAt) || 0) - ((a.summary && a.summary.updatedAt) || 0))
            return rows
          }

          const q = query.trim().toLowerCase()
          const visibleBots = bots.filter(bot => q === '' || `${bot.name} ${bot.role || ''}`.toLowerCase().includes(q))
          const visibleGroups = groups.filter(group => q === '' || `${group.name} ${(group.messages || []).slice(-1).map(m => m.text).join(' ')}`.toLowerCase().includes(q))

          const selectedBot = selection && selection.kind === 'bot'
            ? bots.find(bot => bot.id === selection.id)
            : undefined
          const activeBot = selectedBot || (selection && selection.kind === 'group' ? undefined : bots[0])
          const activeGroup = selection && selection.kind === 'group'
            ? groups.find(group => group.id === selection.id)
            : undefined
          const activeSessionId = activeBot ? activeBot.sessionId : null
          const activeRows = activeBot ? sessionRowsOf(activeBot) : []

          const openBotEntry = (bot) => { setSelection({ kind: 'bot', id: bot.id }); setForm(null) }
          const openGroupEntry = (group) => { setSelection({ kind: 'group', id: group.id }); setForm(null) }
          const createGroup = (draft) => {
            const group = {
              id: newId(),
              name: draft.name,
              color: COLORS[(groups.length + 2) % COLORS.length],
              members: draft.members,
              createdAt: Date.now(),
              lastSeen: Date.now(),
              messages: [],
            }
            saveGroups([...groups, group])
            setForm(null)
            setSelection({ kind: 'group', id: group.id })
          }
          const saveGroup = (group, draft) => {
            saveGroups(groups.map(item => (item.id === group.id ? { ...item, name: draft.name, members: draft.members } : item)))
            setForm(null)
          }
          const deleteGroup = (group) => {
            saveGroups(groups.filter(item => item.id !== group.id))
            setForm(null)
            setSelection(null)
          }

          const botRow = (bot) => {
            const summary = sessionOf(list, bot)
            const active = activeBot && activeBot.id === bot.id
            const time = bot.lastAt || (summary && summary.updatedAt)
            const unread = !active && (bot.lastAt || 0) > (bot.lastSeen || 0)
            const preview = bot.lastText || bot.role || t('card.noPreview')
            return h('button', {
              key: bot.id, type: 'button', className: 'bm-frow', 'data-active': active,
              onClick: () => openBotEntry(bot),
            },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: bot.color || COLORS[0] } }, initialOf(bot.name)),
              h('span', { className: 'bm-frow-text' },
                h('span', { className: 'bm-frow-top' },
                  h('span', { className: 'bm-frow-name' }, bot.name),
                  time ? h('span', { className: 'bm-frow-time' }, new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
                h('span', { className: 'bm-frow-preview' }, preview)),
              unread ? h('span', { className: 'bm-unread' }) : null)
          }

          const groupRow = (group) => {
            const active = activeGroup && activeGroup.id === group.id
            const last = (group.messages || []).length > 0 ? group.messages[group.messages.length - 1] : undefined
            const unread = !active && (group.lastAt || 0) > (group.lastSeen || 0)
            const preview = last ? `${last.name}: ${last.text}` : t('group.emptyPreview')
            return h('button', {
              key: group.id, type: 'button', className: 'bm-frow', 'data-active': active,
              onClick: () => openGroupEntry(group),
            },
              h('span', { className: 'bm-avatar bm-avatar-sm', style: { background: group.color || COLORS[3] } }, initialOf(group.name)),
              h('span', { className: 'bm-frow-text' },
                h('span', { className: 'bm-frow-top' },
                  h('span', { className: 'bm-frow-name' }, group.name),
                  group.lastAt ? h('span', { className: 'bm-frow-time' }, new Date(group.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null),
                h('span', { className: 'bm-frow-preview' }, preview)),
              unread ? h('span', { className: 'bm-unread' }) : null)
          }

          const pane = h('aside', { className: 'bm-pane' },
            h('div', { className: 'bm-pane-head' },
              h('span', { className: 'bm-pane-title' }, t('pane.title')),
              h('button', { className: 'bm-btn small primary', onClick: () => setForm({ mode: 'create' }) }, t('page.new'))),
            h('input', {
              className: 'bm-search', value: query, placeholder: t('pane.search'),
              onChange: event => setQuery(event.target.value),
            }),
            h('div', { className: 'bm-groups' },
              h('div', { className: 'bm-section' }, t('pane.bots')),
              visibleBots.length === 0
                ? h('p', { className: 'bm-muted bm-pane-empty' }, t('pane.empty'))
                : visibleBots.map(botRow),
              h('div', { className: 'bm-section' },
                h('span', null, t('pane.groups')),
                h('button', { className: 'bm-section-add', onClick: () => setForm({ mode: 'group' }) }, t('pane.newGroup'))),
              visibleGroups.length === 0
                ? h('p', { className: 'bm-muted bm-pane-empty' }, t('group.none'))
                : visibleGroups.map(groupRow)),
            h('div', { className: 'bm-pane-foot' },
              h('button', { className: 'bm-btn small', onClick: toHarness }, t('foot.back'))))

          const detailBody = activeBot
            ? h(BotDetail, {
              bot: activeBot,
              summary: sessionOf(list, activeBot),
              sessions: activeRows,
              brief: bots.length >= 2 ? h(BriefBox, { bots }) : null,
              onOpen: openBot,
              onOpenSession: (id) => setSelection({ kind: 'bot', id: activeBot.id }),
              onEdit: (bot) => setForm({ mode: 'edit', bot }),
              onDelete: deleteBot,
              onMigrate: (bot) => migrateBot(bot, activeLang),
            })
            : null
          const detail = form
            ? form.mode === 'group'
              ? h(GroupForm, {
                bots,
                onCancel: () => setForm(null),
                onSave: createGroup,
              })
              : form.mode === 'groupEdit'
                ? h(GroupForm, {
                  bots,
                  group: form.group,
                  onCancel: () => setForm(null),
                  onSave: (draft) => saveGroup(form.group, draft),
                  onDelete: () => deleteGroup(form.group),
                })
                : h(BotForm, {
                  mode: form.mode,
                  bot: form.bot,
                  lang: activeLang,
                  initial: form.mode === 'create'
                    ? { name: '', role: '', instructions: '', color: COLORS[(bots.length + 1) % COLORS.length] }
                    : { name: form.bot.name, role: form.bot.role || '', instructions: form.bot.instructions || '', color: form.bot.color || COLORS[0] },
                  onCancel: () => setForm(null),
                  onDone: () => setForm(null),
                })
            : activeGroup
              ? h(GroupChat, {
                key: activeGroup.id,
                group: activeGroup,
                bots,
                onPosted: (bot, text) => patchBot(bot.id, { lastText: text, lastAt: Date.now() }),
                onEdit: () => setForm({ mode: 'groupEdit', group: activeGroup }),
              })
              : activeBot && activeSessionId
                ? h(ChatPane, {
                  key: activeSessionId,
                  sessionId: activeSessionId,
                  bot: activeBot,
                  detail: detailBody,
                  onActivity: botActivity(activeBot),
                  onSeen: botSeen(activeBot),
                })
                : h('section', { className: 'bm-empty bm-detail-empty' },
                  h('h2', null, t('page.empty.title')),
                  h('p', null, t('page.empty.body')),
                  h('button', { className: 'bm-btn primary', onClick: () => setForm({ mode: 'create' }) }, t('page.empty.cta')))

          return h('div', { className: 'bm-page bm-page-split' },
            h('style', null, CSS),
            pane,
            h('section', { className: 'bm-detail-col' }, detail))
        }

        function PanelIcon(props) {
          const size = props.size || 16
          return h('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
          },
            h('rect', { x: 3, y: 6, width: 18, height: 13, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
            h('circle', { cx: 9, cy: 12.5, r: 1.6, fill: 'currentColor' }),
            h('circle', { cx: 15, cy: 12.5, r: 1.6, fill: 'currentColor' }),
            h('path', { d: 'M12 3v3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
        }

        function ModeSwitch(props) {
          const t = useT()
          const panel = useMainPanel()
          const mode = panel && panel.activePanelId === PANEL_ID ? 'bots' : 'harness'
          const choose = (next) => {
            if (next === mode) return
            if (next === 'bots') toBots()
            else toHarness()
          }
          const control = props.wide
            ? h('div', { className: 'bm-switch', role: 'group', 'aria-label': t('mode.label') },
              h('button', {
                type: 'button', 'data-active': mode === 'harness', 'aria-pressed': mode === 'harness',
                title: t(mode === 'harness' ? 'mode.currentHarness' : 'mode.toHarness'),
                onClick: () => choose('harness'),
              }, t('mode.harness')),
              h('button', {
                type: 'button', 'data-active': mode === 'bots', 'aria-pressed': mode === 'bots',
                title: t(mode === 'bots' ? 'mode.currentBots' : 'mode.toBots'),
                onClick: () => choose('bots'),
              }, t('mode.bot')))
            : h('button', {
              type: 'button', className: 'bm-rail', title: t(mode === 'bots' ? 'mode.toHarness' : 'mode.toBots'),
              'aria-label': t(mode === 'bots' ? 'mode.toHarness' : 'mode.toBots'),
              onClick: () => choose(mode === 'bots' ? 'harness' : 'bots'),
            }, h(PanelIcon, { size: 18 }))
          return h('div', { style: { display: 'contents' } }, h('style', null, CSS), props.children, control)
        }

        ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
          name: 'sidebar.session.action',
          id: 'botmode.mode-switch',
          locale: NS,
        }, ModeSwitch))

        const panelLabel = () => {
          const active = String((locale.getLocale() && locale.getLocale().active) || '').toLowerCase()
          return active.startsWith('zh') ? 'Bot 团队' : 'Bots'
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: panelLabel,
          locale: NS,
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, BotsPage))
      },
    }
  },
})