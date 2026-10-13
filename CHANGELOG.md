# Changelog

## 1.4.0 - 2026-10-13

- **Feature:** A background command that outlives the turn shows ⏳ instead of a working clock. Opt-in: `claudeRadar.shellTasksKeepWorking`.
- **Fixed:** Esc no longer empties the title while background agents are still working: 💬 and the 🤖 count stay until they're through.
- **Fixed:** An agent you stopped leaves the 🤖 count right away instead of lingering for ten minutes.
- **Fixed:** A ⚠️ answered without opening its window (from your phone or a terminal) goes back to 💬 within 10 seconds, instead of standing until the running command is through.

## 1.3.0 - 2026-09-16

- **Feature:** Radar reads the status Claude Code writes for each session (Claude Code 2.1.269 or newer). A 💬 left standing after the turn ended goes within 10 seconds, hooks or not. A permission prompt or dialog no hook reported shows ⚠️, and the banner says which: "Needs you: permission prompt".

## 1.2.0 - 2026-09-02

- **Feature:** A turn that ends with a question shows ⚠️ instead of 🟢. Off switch: `claudeRadar.detectQuestions`.
- **Feature:** A turn that died on Claude's side (spend limit, 529, expired session, lost connection) shows 🔴 the moment it happens, and the banner names the cause. A failed last tool call shows 🔴 too.
- **Feature:** Markers clean up after themselves. Esc, quit Claude, close the terminal: the marker goes within 10 seconds.
- **Added:** `claudeRadar.minDoneSeconds` holds back the done banner for short turns. Questions, permissions and failures always notify.
- **Improved:** The agent count holds while an agent thinks or builds, and drops it seconds after it finishes.
- **Improved:** Claude never waits for Radar: the hook after every tool call runs async.
- **Fixed:** A failed tool call right after a permission prompt no longer leaves ⚠️ standing.
- **Updated:** Requires Claude Code 2.1.247 or newer.

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
