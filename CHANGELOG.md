# Changelog

## 1.1.1 - 2026-08-24

- **Feature:** A turn that ends by asking you something now shows ⚠️ instead of 🟢. Claude Code reports a typed question as a plain turn end, so until now the question sat there behind a green "done" marker. Turn it off with `claudeRadar.detectQuestions`.
- **Feature:** Markers clean up after themselves. Interrupt with `Esc`, quit Claude, close the terminal: instead of a 💬 that keeps counting minutes nobody is working, the marker goes within 10 seconds. Radar cross-checks the sessions Claude Code lists in `~/.claude/sessions/` and reads the tail of the session transcript, which records the `Esc` interrupt that fires no hook.
- **Feature:** A turn that failed shows 🔴 instead of 🟢, with its own sound. That covers a failed last tool call (a failure Claude recovered from still ends green) and, new in this release, a turn that died on Claude's side: a spend limit, a 529, an expired session, a connection lost mid-response. Those fire no hook and leave the session running, so until now the tab just kept counting minutes in which nothing could happen. The banner names the cause, so you can tell a retry from something you have to go fix. Configurable via `claudeRadar.markerError` and `claudeRadar.soundError`.
- **Added:** `claudeRadar.minDoneSeconds` holds back the done banner for turns shorter than you care about. Questions, permissions, and failures always notify, however short the turn was.
- **Updated:** The README no longer claims an `Esc`-interrupted turn is beyond Radar's reach. It only means the marker goes on the next check instead of instantly.

## 1.1.0 - 2026-08-11

- **Feature:** The working marker counts the subagents running in your project: `💬 14m 🤖8`. Watch a multi-agent review fan out and wind down, straight from the tab bar. The symbol is configurable via `claudeRadar.markerAgents`; empty hides the count.
- **Updated:** New demo GIF showing the agent count in action, in a flat look with a transparent background that blends into GitHub's dark and light mode.

## 1.0.7 - 2026-07-25

- **Feature:** The done banner says how long the run took: "Done after 23m". Below a minute it just says "Done".
- **Added:** Radar works in VS Code's Restricted Mode.
- **Fixed:** Radar leaves your other Claude hooks alone. Installing or updating its own used to drop commands of yours that shared a hook group.
- **Fixed:** Setup works when your workspace sets its own `window.title`. Radar wrote the marker variable where it could never take effect, and still said "Done."
- **Fixed:** ⚠️ only shows up when something really waits for you. A finished login or background agent no longer rings.
- **Fixed:** `~/.claude/settings.json` keeps its permissions and its symlink when Radar writes to it.
- **Fixed:** "Clear marker" stays cleared. A marker left over from an `Esc`-interrupted turn used to come back a minute later.

## 1.0.6 - 2026-07-19

- **Updated:** New demo GIF, 💬 12m · ⚠️ · 🟢 side by side, and the banner click that lands in the right project.
- **Fixed:** Fresh installs looked broken while a Claude session was still running. Hooks load at session start, so the setup now tells you to restart running sessions.

## 1.0.5 - 2026-07-15

- **Updated:** The README's limits now spell out that `Esc` fires no Claude hook at all, so 💬 stays until your next prompt clears it.
- **Fixed:** The working time no longer keeps counting after you interrupt Claude. Hit `Esc`, fix your typo, send the prompt again, and the clock starts at zero instead of showing minutes you never worked.

## 1.0.4 - 2026-07-14

- **Feature:** The working marker shows elapsed time (`💬 14m`). Not your thing? Turn off `claudeRadar.showWorkingTime`.
- **Improved:** Marketplace listing polish, author metadata, AI category, more searchable tags.
- **Updated:** Open source, said out loud. The README links the full code on GitHub.
- **Fixed:** 💬 no longer goes missing on long runs. Answering a permission prompt used to leave the title empty while Claude kept working.
- **Fixed:** Banner clicks land in the right editor. VS Code, Insiders, Cursor, all fine now, and the `code` shell command is no longer needed for it.

## 1.0.3 - 2026-07-07

- **Feature:** New commands, **Mute banners for 1 hour** and **Unmute banners**, for screen sharing and presentations. Sounds pause too; the title markers keep working.
- **Updated:** Refreshed README with a tips section and a clearer feature overview.

## 1.0.2 - 2026-07-07

- **Feature:** If terminal-notifier is missing, Radar offers to install it via Homebrew, so a banner click jumps into the right window.
- **Improved:** Setup you can't miss. Radar keeps offering its one-time setup until it's done (or you opt out), and says clearly that no marker shows without it.

## 1.0.1 - 2026-07-07

- **Improved:** Banners carry the Radar icon (shown on the banner's right, via terminal-notifier's content image).
- **Updated:** README with an animated demo of the tab bar as a live status board (working, needs you plus banner, done).

## 1.0.0 - 2026-07-07

First public release. Radar shows each project's Claude Code status right in the window title, so across several projects you can tell at a glance which one needs you.

- **Three states in the title:** 💬 working, ⚠️ needs you, 🟢 done.
- **Background banner and sound** when an out-of-focus window needs you or finishes; the window you're looking at stays quiet.
- **Native tabs become a live status board**, every project's status in one bar. Works without native tabs too (title bar, window switcher, Mission Control).
- **Background-aware "done":** subagents, workflows, and monitors keep the working marker until they finish, so a "done" banner never fires early. A dev server Claude started won't hold the marker forever (opt in with `claudeRadar.shellTasksKeepWorking`).
- **Self-installing Claude hooks** in `~/.claude/settings.json` (a backup is written), reconciled automatically on update.
- **Configurable** markers, sounds, and banner.

macOS only.
