# Radar for Claude Code

![The native tab bar as a live status board: working, needs you, done](media/radar-demo.gif)

**Claude Code multitasking, done right.** Running Claude across several projects? Each window title shows what it's doing, working, needs you, or done, so you see at a glance which one to jump to instead of clicking through window after window. Banner and sound when a window's in the background; a focused window stays quiet.

The status lives in the window title, so you see it wherever macOS shows titles: side-by-side windows, the window switcher, Mission Control. Turn on **native tabs** and every project packs into one tab bar for the tightest view. Works either way.

**macOS only** (banners, sounds, native tabs, and the hook tools are all macOS).

## Requirements

- VS Code ≥ 1.93 (uses `registerWindowTitleVariable`)
- Claude Code (hooks live in `~/.claude/settings.json`)
- macOS. `terminal-notifier` (Homebrew) makes banners clickable; without it there's an `osascript` fallback (notification + sound, not clickable)

## Setup

**Tip:** for the tightest view, turn on native tabs so every project's status sits in one bar. Set `"window.nativeTabs": true` and restart VS Code. Optional, though, the marker works without it too, you just read it from each window's title bar.

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

