# Changelog

## 1.0.0 - 2026-07-07

First public release. Radar shows each project's Claude Code status right in the window title, so across several projects you can tell at a glance which one needs you.

- **Three states in the title:** 💬 working, ⚠️ needs you, 🟢 done.
- **Background banner and sound** when an out-of-focus window needs you or finishes; the window you're looking at stays quiet.
- **Native tabs become a live status board**, every project's status in one bar. Works without native tabs too (title bar, window switcher, Mission Control).
- **Background-aware "done":** subagents, workflows, and monitors keep the working marker until they finish, so a "done" banner never fires early. A dev server Claude started won't hold the marker forever (opt in with `claudeRadar.shellTasksKeepWorking`).
- **Self-installing Claude hooks** in `~/.claude/settings.json` (a backup is written), reconciled automatically on update.
- **Configurable** markers, sounds, and banner.

macOS only.
