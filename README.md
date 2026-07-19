<h1 align="center">
  <img src="icon.png" width="96" alt="Radar for Claude Code icon"><br>
  Radar for Claude Code
</h1>

<p align="center"><strong>💬 working&ensp;·&ensp;⚠️ needs you&ensp;·&ensp;🟢 done</strong></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=seeligmx.radar-for-claude-code"><img src="https://badgen.net/vs-marketplace/v/seeligmx.radar-for-claude-code?color=ff4d1f&label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>&emsp;<a href="https://seelig.mx"><img src="https://img.shields.io/badge/Made%20by-SEELIG%E2%84%A2-white" alt="Made by SEELIG"></a>&emsp;<a href="https://x.com/seeligmx"><img src="https://img.shields.io/badge/Follow%20on%20X-%40seeligmx-white" alt="Follow @seeligmx on X"></a>
</p>

![The native tab bar as a live status board: working, needs you, done](media/radar-demo.gif)

**Claude Code multitasking, done right.** Run Claude across several projects and always know which one needs you, without clicking through window after window.

## Two features, one glance

- **Live status in every window title.** 💬 working, ⚠️ needs you, 🟢 done. Every project, one look.
- **macOS banners and sounds.** A background window pings you when it needs you or finishes, one click jumps right in. The window you're looking at stays quiet.

## Tips

- **Native tabs are the killer setup.** Set `"window.nativeTabs": true` in your settings and restart: every window packs into one tab bar, a live status board for all your Claudes. Already have windows open? **Window → Merge All Windows** pulls them all into one bar. (Radar works without native tabs too: title bar, window switcher, Mission Control.)
- **Switch projects without the mouse.** Bind `workbench.action.showPreviousWindowTab` and `showNextWindowTab` to keys you like (`⌘←` / `⌘→` work nicely), and step straight to the Claude that needs you. Without native tabs, `` ⌘` `` cycles through the windows.
- **Presenting?** Run **Mute banners for 1 hour** from the Command Palette, sounds pause too and the markers keep working. For quiet by default, empty `claudeRadar.soundWaiting` / `soundDone` or turn `claudeRadar.banner` off.

## Requirements

- VS Code ≥ 1.93 · Claude Code · **macOS only**
- `terminal-notifier` (Homebrew) makes banners clickable; without it you still get notification + sound

## Setup

Radar offers to set itself up on first launch and keeps reminding you until it's done: **both steps are required, no marker shows without them.** If `terminal-notifier` is missing, it offers the Homebrew install too. Or do it via the Command Palette: **Add ${claudeRadarStatus} to window.title**, then **Install Claude hooks** (writes to `~/.claude/settings.json`, backup first, other hooks stay put). Claude loads hooks at session start, so restart any session that's already running. Updates keep the hooks current automatically. Uninstalling? Run **Remove Claude hooks** first, then uninstall.

## Privacy, performance & trust

- **No network, no telemetry.** Everything happens in local files.
- **Event-driven, not polling.** Idle cost is effectively zero.
- **Safe config writes.** Atomic, with a backup. Removal is one command.
- **Open source.** [Full code on GitHub](https://github.com/seeligmx/radar-for-claude-code).

## How it works

Six Claude hooks drop a file in `~/.claude/tab-status/`, named `sha256(project path)` (first 16 hex chars, realpath-resolved so symlinks match). The content is the status:

- `UserPromptSubmit` → `prompt` (shows `working`, purely visual, no banner/sound; its own label so a new prompt restarts the elapsed-time clock)
- `Notification` / `PermissionRequest` → `waiting`
- `PreToolUse` + `AskUserQuestion` → `waiting` (a question needs you too; its own hook, since AskUserQuestion fires neither Stop nor Notification)
- `PostToolUse` → `working` (every completed tool call flips back to working, so an answered question or a granted permission doesn't leave the title empty while Claude keeps going)
- `Stop` → `stop` (done), unless background work is still running, then `working` stays. Subagents, workflows, and monitors count as work (they finish and wake the session); background shell tasks don't, since a dev server Claude started would otherwise hold the working marker forever. Want shell tasks to count? Turn on `claudeRadar.shellTasksKeepWorking`.

Each window watches only its own file and shows the marker from **state + focus**:

- `working` stays visible the whole time, even in the active window, never with banner/sound, so nothing flickers.
- `needs you` / `done` show a persistent marker and banner only when the window's in the background (banner via `terminal-notifier`, a click focuses the right window). In the active window they flash for ~1 s ("peek") and fade.
- Focusing a window clears an attention marker; `working` stays, since Claude's still going.

Stale files (sessions with no matching window) are cleaned up after 24 h.

## Limits

- The marker is text (emoji) in the title, not a native tab badge, macOS doesn't allow those.
- `Stop` fires after every response. Fine for the marker and banner (idempotent, one banner per project, focused windows skipped).
- Interrupting Claude with `Esc` fires no hook at all, so 💬 stays until your next prompt (which clears it, elapsed time included). Nothing Radar can fix from the outside: Claude Code has no interrupt event.
- Multi-root workspaces: the first folder wins.
- Two events at once: the later one wins.

## Settings

Give just the symbol, the space is added for you. Empty means no marker for that status.

| Setting | Default | |
| --- | --- | --- |
| `claudeRadar.markerWorking` | `💬` | while Claude is working |
| `claudeRadar.showWorkingTime` | `true` | show the elapsed time in the working marker (`💬 14m`) |
| `claudeRadar.markerWaiting` | `⚠️` | when Claude needs you |
| `claudeRadar.markerDone` | `🟢` | when Claude is done |
| `claudeRadar.banner` | `true` | macOS banner on/off |
| `claudeRadar.soundWaiting` | `Basso` | sound when needs you (empty = silent) |
| `claudeRadar.soundDone` | `Glass` | sound when done (empty = silent) |
| `claudeRadar.shellTasksKeepWorking` | `false` | background shell tasks (e.g. a dev server) keep the working marker |
