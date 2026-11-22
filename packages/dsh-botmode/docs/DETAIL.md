# Bot mode

Bot mode adds a second way to work in the session bar: beside **Harness mode**
(the normal session list and conversation), a **Bot** roster holds named,
long-lived assistants. Each Bot gets **its own workspace**, and that workspace
folder is the Bot's built-in setup.

## Hermes-style roster and group chats

The left column follows Hermes Bot Mode's sidebar rather than the Workspace tree:

- **Bot rows**: avatar, name, last-message preview, time, and an unread dot once
  a Bot has spoken since you last opened it.
- **Group rows**: avatar, name, member count, last message preview, unread dot.
- Search filters both lists. `New` creates a Bot; `New` beside **Group chats**
  creates a room by naming it and picking at least two Bots.

A group chat is one shared transcript. When you send a message, every member is
asked in its own session, and each member's reply is posted back into the room
under its name, with the Bot's roster preview updated. This is how DSH works
under the hood: one Session has one agent, so the room is a plugin-owned
transcript over per-Bot sessions rather than a single Host session. The room
log (messages, members, last seen) lives in this browser
(`dsh.botmode.groups.v1`); the conversations stay in each Bot's session.

## Chat inside the Bot page

Bot mode no longer jumps to the Harness conversation. The right column is a chat
surface of its own:

- the Bot's messages and the user's messages render as bubbles, with tool calls
  as compact rows and streamed text as a live bubble;
- the composer sends into that Bot's session and **Enter** sends, **Shift+Enter**
  adds a line; **Stop** cancels a running turn;
- older messages load from the session history when the window starts mid-log;
- **Details** switches the right column to the Bot's profile, workspace and
  action list without leaving Bot mode.

The chat is a focused replica, not the full Harness conversation: Markdown is
plain text, and approvals, attachments, model picking and slash commands stay in
**Open in Harness**.

## Two separate spaces

Bot mode and Harness mode share one Host session list and one Workspace registry,
and DSH exposes no filter for either. This bundle therefore narrows what the
Harness sidebar reads:

- **Harness mode** shows only non-Bot workspaces and sessions; every Bot
  workspace and Bot chat disappears from the sidebar.
- **Bot mode** shows only Bot workspaces and their sessions; the user's normal
  workspaces disappear.

The Bot pane repeats that classification in the main column: Bots are the groups,
their sessions are the rows, and the detail column holds the selected Bot. The
switch next to **New session** changes both surfaces together.

The filter is client-side and keyed on the Bot directories this browser's roster
knows, so a browser whose roster is empty cannot hide the Bot workspaces it has
never seen (see the limits below).

## Use it

1. In the session bar, press **Harness** or **Bot** in the mode switch next to
   **New session**. The switch also exists as a **Bots** row in the sidebar and
   a single icon button when the sidebar is collapsed to the rail.
2. Bot mode opens the Bots page. Press **New bot**, give it a name, a role and
   standing instructions, and create it.
3. Creating a Bot builds a workspace folder named after it and writes the Bot's
   setup into that folder:

   ```
   <bots root>/<Bot>/
     AGENTS.md                     persona + role + standing instructions + team rules
     SOUL.md                       the same persona, for people
     bot.json                      name, role, colour, created time
     TEAM.md                       the team roster
     .dsh/skills/team/SKILL.md     the team skill every Bot loads
   ```

   The workspace is registered in DSH under the Bot's name, and the Bot's chat
   session is created inside it, so the folder is the Bot's whole world.
4. Press **Open chat** on a Bot card to talk to it. **Edit** updates the card and
   rewrites the workspace files (`AGENTS.md`, `SOUL.md`, `TEAM.md`, the skill) and
   renames the workspace when the name changes. **Delete** removes the Bot from
   the roster; its workspace and chat stay on disk.
5. **Brief the team** sends one message to every Bot you tick; each answer arrives
   in that Bot's own chat.

## How Bots talk to each other

Every Bot workspace carries a `team` skill and the `team_board` tool:

- `team_board` `action="roster"` — the Bots and their roles.
- `team_board` `action="read"` — recent posts, newest last.
- `team_board` `action="post"` `text="@Name …"` — leave a message on the shared
  board (`<bots root>/.team/board.jsonl`).

The board is shared by every Bot on the machine. It is **asynchronous**: a post
is a note a teammate reads the next time it runs; nothing wakes the other Bot.
Bots are told to read the board before work that involves a teammate, and to
answer an `@Name` request by posting back.

## Where the bots root is

The first Bot asks for a folder (the host directory picker) and remembers it in
this browser. If the picker is unavailable, it falls back to a `DSH-Bots` folder
next to the first registered workspace. The root is stored as
`dsh.botmode.root.v1` in `localStorage`; the roster is `dsh.botmode.roster.v1`.

## Host requirement

Creating a Bot through the Host command (`/botmode scaffold`) and the
`team_board` tool come from this bundle's **Host** half. A DSH process that was
already running before the bundle was updated keeps the old Host half until it
restarts: Bot creation then falls back to asking the Bot to write its own setup
files in its first turn, and `team_board` is unavailable. Restart DSH (or the
`dsh web` process) once after installing this version.

## Version 0.2 limits

- The board is asynchronous; there is no wake-up or direct DM tool yet.
- Group chats reply once per member per message, captured when that member's turn
  ends (180 s cap). There are no rounds, @mentions, pass/silence or room memory
  beyond the transcript, and the room log is browser-local.
- Bots created by 0.1 live in the workspace they were created in and have no
  own folder; recreate them to move them onto the new layout (their old chat
  stays readable in Harness mode).
- The roster is browser-local; two browsers on one profile keep separate
  rosters. The workspaces and the board are on disk, so they are shared. A
  browser that never created a Bot does not know its directory, so the mode
  filter cannot hide that Bot's workspace from Harness there.
- Each Bot workspace appears in Harness mode as a normal workspace (it is one).
- A Bot's model is chosen in its chat; there is no per-Bot model pin yet.

## Verified in this installation

- Create two Bots from the page: each got a workspace folder named after it,
  with `AGENTS.md`, `SOUL.md`, `bot.json`, `TEAM.md` and the team skill.
- The workspace title equals the Bot name; the chat session lives in it.
- `team_board` roster / read / post from two Bots: Writer read Scout's post and
  answered `@Scout`; Scout read Writer's answer and replied on the board.
- Brief the team with two Bots (verified in 0.1).
- Edit, delete confirmation, mode switch in the wide sidebar and the 56px rail.
- Bot pane: Bot groups with session rows, detail column, search.
- Space separation: Harness mode hid every Bot workspace and chat; Bot mode hid
  every non-Bot workspace and chat (verified by switching both ways).
- Hermes-style roster with previews, times and unread dots; group row preview.
- Group chat: created 圆桌 with Alpha and Beta; one user message produced one
  attributed reply from each Bot in the shared transcript, both inside Bot mode.
- Plugin Manager row with localized title, description and icon.