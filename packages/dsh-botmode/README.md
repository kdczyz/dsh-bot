# Bot mode (`@local/dsh-botmode`)

A DeepSeek Harness bundle that adds a Bot roster and a **Harness / Bot** mode
switch to the session bar.

- **Harness mode**: the normal session list and conversation.
- **Bot mode**: a roster of named Bots. Each Bot gets its own workspace folder
  named after it; the persona, role and standing instructions are written into
  `AGENTS.md`, `SOUL.md`, `bot.json`, `TEAM.md` and
  `.dsh/skills/team/SKILL.md` in that folder, and the Bot's chat session lives
  there.
- **Team board**: every Bot carries the `team_board` tool, so Bots on this
  machine can read and post messages to each other (`<bots root>/.team/board.jsonl`).

Each Bot workspace is a normal DSH workspace, so it also appears in Harness
mode under the Bot's name.

Install this directory through **Plugins → Add plugin** (or
`dsh plugin add <this directory>`), then reload the page. Restart the `dsh web`
process once after installing or updating, so the Host half (the `/botmode`
command and `team_board`) loads; the UI works without a restart but falls back to
in-chat setup.

Version 0.2: own workspace per Bot, persona files, team board. The board is
asynchronous; direct Bot-to-Bot wake-up is not implemented yet. See
`docs/DETAIL.md`.
