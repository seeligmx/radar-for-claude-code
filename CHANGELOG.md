# Changelog

## 1.0.4 - 2026-07-08

- README says it out loud now: Radar is open source, read every line on GitHub ("Privacy, performance & trust").
- Marketplace listing polish: author metadata, AI category, more searchable tags.

## 1.0.3 - 2026-07-07

- New commands: **Mute banners for 1 hour** and **Unmute banners**, for screen sharing and presentations. Sounds pause too; the title markers keep working.
- Refreshed README: tips section, clearer feature overview.

## 1.0.2 - 2026-07-07

- Setup you can't miss: Radar keeps offering its one-time setup until it's done (or you opt out), and says clearly that no marker shows without it.
- If terminal-notifier is missing, Radar offers to install it via Homebrew, so a banner click jumps into the right window.

## 1.0.1 - 2026-07-07

- Banners now carry the Radar icon (shown on the banner's right, via terminal-notifier's content image).
- README: animated demo of the tab bar as a live status board (working, needs you plus banner, done).

## 1.0.0 - 2026-07-07

First public release. Radar shows each project's Claude Code status right in the window title, so across several projects you can tell at a glance which one needs you.

- **Three states in the title:** 💬 working, ⚠️ needs you, 🟢 done.
- **Background banner and sound** when an out-of-focus window needs you or finishes; the window you're looking at stays quiet.
- **Native tabs become a live status board**, every project's status in one bar. Works without native tabs too (title bar, window switcher, Mission Control).
- **Background-aware "done":** subagents, workflows, and monitors keep the working marker until they finish, so a "done" banner never fires early. A dev server Claude started won't hold the marker forever (opt in with `claudeRadar.shellTasksKeepWorking`).
- **Self-installing Claude hooks** in `~/.claude/settings.json` (a backup is written), reconciled automatically on update.
- **Configurable** markers, sounds, and banner.

macOS only.
