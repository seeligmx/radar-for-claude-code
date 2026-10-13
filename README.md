<h1 align="center">
  <img src="icon.png" width="96" alt="Radar for Claude Code icon"><br>
  Radar for Claude Code
</h1>

<p align="center"><strong>💬 working&ensp;·&ensp;⚠️ needs you&ensp;·&ensp;🟢 done&ensp;·&ensp;🔴 failed&ensp;·&ensp;🤖 agents</strong></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=seeligmx.radar-for-claude-code"><img src="https://badgen.net/vs-marketplace/v/seeligmx.radar-for-claude-code?color=ff4d1f&label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>&emsp;<a href="https://seelig.mx"><img src="https://img.shields.io/badge/Made%20by-SEELIG%E2%84%A2-white" alt="Made by SEELIG"></a>&emsp;<a href="https://x.com/seeligmx"><img src="https://img.shields.io/badge/Follow%20on%20X-%40seeligmx-white" alt="Follow @seeligmx on X"></a>
</p>

![The native tab bar as a live status board: working, needs you, done](media/radar-demo.gif)

**Claude Code multitasking, done right.** Run Claude across a handful of projects and know at a glance which one needs you. No clicking through windows to check.

## What you get

- **Status in every window title.** 💬 working, ⚠️ needs you, 🟢 done, 🔴 failed. A question Claude typed counts as ⚠️, so it never hides behind a green marker.
- **Live agent count.** Claude fans out into subagents or a workflow? The title counts them while they run: `💬 14m 🤖8`.
- **Markers that don't lie.** `Esc`, a closed terminal, a spend limit, a 529: the marker follows within seconds instead of counting minutes nobody is working.
- **Banners and sounds.** A background window pings you when it needs you or finishes. One click takes you there. The window you're looking at stays quiet.

## Get started

**macOS only** · VS Code ≥ 1.93 · Claude Code ≥ 2.1.247, best with 2.1.269 or newer

Install it, and Radar walks you through two steps on first launch. Both are required, no marker shows without them:

1. **Add the status to your window title.**
2. **Install the Claude hooks.** They go into `~/.claude/settings.json`, with a backup. Your own hooks stay untouched.

Restart any Claude session that is already running, and you're set. Updates keep the hooks current.

Optional: `terminal-notifier` (Homebrew) makes the banners clickable. Radar offers to install it. Uninstalling? Run **Remove Claude hooks** from the Command Palette first.

## Tips

- **Native tabs are the killer setup.** Set `"window.nativeTabs": true` and restart: every window joins one tab bar, a live status board for all your Claudes. **Window → Merge All Windows** pulls open windows in.
- **Switch without the mouse.** Bind `workbench.action.showPreviousWindowTab` and `showNextWindowTab` (`⌘←` / `⌘→` work nicely) and step straight to the Claude that needs you.
- **Presenting?** Run **Mute banners for 1 hour** from the Command Palette. The markers keep working.
- **Long scripts in the background?** Turn on `claudeRadar.shellTasksKeepWorking`. A command that outlives the turn then holds ⏳ instead of showing done.

## Privacy and performance

- **No network, no telemetry.** Everything stays in local files.
- **Event-driven.** With an empty title nothing runs at all. While a marker shows, a light check runs every 10 s.
- **Claude never waits for Radar.** The hook after each tool call runs async.
- **Open source.** [Read the code on GitHub](https://github.com/seeligmx/radar-for-claude-code).

## How it works

Claude Code hooks write the current status to a small file per project in `~/.claude/tab-status/`. Each window watches its own file and puts the marker into its title. While a marker shows, Radar checks it against Claude Code's own session registry and transcripts. That is how it notices what no hook reports: an `Esc`, a session that died, a prompt you answered from your phone.

## Good to know

- The marker is emoji text in the title. macOS doesn't allow native tab badges.
- An `Esc` shows up within 10 s, not instantly: Claude Code fires no hook for it.
- 🔴 means the turn failed technically. A task Claude says it can't do still ends green.
- Agents running in Anthropic's cloud aren't counted.
- Multi-root workspaces: the first folder wins.

## Settings

Give just the symbol, the space is added for you. Empty means no marker for that status.

| Setting | Default | |
| --- | --- | --- |
| `claudeRadar.markerWorking` | `💬` | Claude is working |
| `claudeRadar.showWorkingTime` | `true` | elapsed time next to it (`💬 14m`) |
| `claudeRadar.markerAgents` | `🤖` | prefix for the subagent count (`🤖8`); empty hides it |
| `claudeRadar.markerWaiting` | `⚠️` | Claude needs you |
| `claudeRadar.markerDone` | `🟢` | Claude is done |
| `claudeRadar.markerError` | `🔴` | the turn failed |
| `claudeRadar.detectQuestions` | `true` | a turn ending in a question counts as ⚠️, not 🟢 |
| `claudeRadar.banner` | `true` | macOS banners on/off |
| `claudeRadar.minDoneSeconds` | `0` | banner "done" only when the turn ran this long |
| `claudeRadar.soundWaiting` | `Basso` | sound for needs you (empty = silent) |
| `claudeRadar.soundDone` | `Glass` | sound for done (empty = silent) |
| `claudeRadar.soundError` | `Basso` | sound for a failed turn |
| `claudeRadar.shellTasksKeepWorking` | `false` | a background command that outlives the turn holds a marker instead of done |
| `claudeRadar.markerShellTask` | `⏳` | that marker |
