<h1 align="center">
  <img src="icon.png" width="96" alt="Radar for Claude Code icon"><br>
  Radar for Claude Code
</h1>

<p align="center"><strong>💬 working&ensp;·&ensp;⚠️ needs you&ensp;·&ensp;🟢 done</strong></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=seeligmx.radar-for-claude-code"><img src="https://badgen.net/vs-marketplace/v/seeligmx.radar-for-claude-code?color=ff4d1f&label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <img src="https://badgen.net/badge/license/MIT/555" alt="MIT license">
  <img src="https://badgen.net/badge/platform/macOS/555" alt="macOS only">
</p>

![The native tab bar as a live status board: working, needs you, done](media/radar-demo.gif)

**Claude Code multitasking, done right.** Run Claude across several projects and always know which one needs you, without clicking through window after window.

## Two features, one glance

**📡 Live status in every window title.** Each project's title and native tab shows what its Claude is up to: 💬 working, ⚠️ needs you, 🟢 done. All projects, one look.

**🔔 macOS banners and sounds.** When a background window needs you or finishes, a native notification pings you, and a click jumps straight into the right window. The window you're focused on stays quiet.

> [!TIP]
> **Did you know? VS Code on macOS has native tabs.** Set `"window.nativeTabs": true`, restart VS Code, and every project window packs into one tab bar, which turns it into a live status board for all your Claudes. Radar works without it too (title bar, window switcher, Mission Control), but this is the tightest view.

**macOS only** (banners, sounds, native tabs, and the hook tools are all macOS).

## Requirements

- VS Code ≥ 1.93 (uses `registerWindowTitleVariable`)
- Claude Code (hooks live in `~/.claude/settings.json`)
- macOS. `terminal-notifier` (Homebrew) makes banners clickable; without it there's an `osascript` fallback (notification + sound, not clickable)

## Setup

On first launch the extension offers to set itself up. Or do it from the Command Palette:

1. **Radar for Claude Code: Add ${claudeRadarStatus} to window.title** prepends `${claudeRadarStatus}` to your title (user settings, no workspace changes).
2. **Radar for Claude Code: Install Claude hooks** adds six hooks to `~/.claude/settings.json` (backup first). Your old entries are replaced on upgrade; other hooks stay put.

After an update the extension reconciles its own hooks on startup, so a new hook gets added silently. The manual command is only for the first install.

Removing it? VS Code doesn't run extension code on uninstall, so run **Radar for Claude Code: Remove Claude hooks** first (backup written, only its own hooks touched), then uninstall.

## How it works

Six Claude hooks drop a file in `~/.claude/tab-status/`, named `sha256(project path)` (first 16 hex chars, realpath-resolved so symlinks match). The content is the status:

- `UserPromptSubmit` → `working` (purely visual, no banner/sound)
- `Notification` / `PermissionRequest` → `waiting`
- `PreToolUse` + `AskUserQuestion` → `waiting` (a question needs you too; its own hook, since AskUserQuestion fires neither Stop nor Notification)
- `PostToolUse` + `AskUserQuestion` → `working` (back to working after you answer, since no new `UserPromptSubmit` fires)
- `Stop` → `stop` (done), unless background work is still running, then `working` stays. Subagents, workflows, and monitors count as work (they finish and wake the session); background shell tasks don't, since a dev server Claude started would otherwise hold the working marker forever. Want shell tasks to count? Turn on `claudeRadar.shellTasksKeepWorking`.

Each window watches only its own file and shows the marker from **state + focus**:

- `working` stays visible the whole time, even in the active window, never with banner/sound, so nothing flickers.
- `needs you` / `done` show a persistent marker and banner only when the window's in the background (banner via `terminal-notifier`, a click focuses the right window). In the active window they flash for ~1 s ("peek") and fade.
- Focusing a window clears an attention marker; `working` stays, since Claude's still going.

Stale files (sessions with no matching window) are cleaned up after 24 h.

## Privacy & performance

- **No network, no telemetry.** Radar never phones home; everything happens in local files on your Mac.
- **Event-driven, not polling.** Markers arrive via file-system events; the idle cost is effectively zero.
- **Config safety.** Every write to `~/.claude/settings.json` is atomic and leaves a backup next to it. Removal is one command, and only Radar's own entries are touched.

## Limits

- The marker is text (emoji) in the title, not a native tab badge, macOS doesn't allow those.
- `Stop` fires after every response. Fine for the marker and banner (idempotent, one banner per project, focused windows skipped).
- Multi-root workspaces: the first folder wins.
- Two events at once: the later one wins.

## Settings

Give just the symbol, the space is added for you. Empty means no marker for that status.

| Setting | Default | |
| --- | --- | --- |
| `claudeRadar.markerWorking` | `💬` | while Claude is working |
| `claudeRadar.markerWaiting` | `⚠️` | when Claude needs you |
| `claudeRadar.markerDone` | `🟢` | when Claude is done |
| `claudeRadar.banner` | `true` | macOS banner on/off |
| `claudeRadar.soundWaiting` | `Basso` | sound when needs you (empty = silent) |
| `claudeRadar.soundDone` | `Glass` | sound when done (empty = silent) |
| `claudeRadar.shellTasksKeepWorking` | `false` | background shell tasks (e.g. a dev server) keep the working marker |
