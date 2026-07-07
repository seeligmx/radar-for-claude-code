// Radar for Claude Code
//
// How it works:
// 1. Registers the window-title variable ${claudeRadarStatus} (VS Code >= 1.93,
//    "registerWindowTitleVariable" command); its value comes from a context
//    key. In-memory only, no per-window settings writes.
// 2. Claude Code hooks write a marker file per event to
//    ~/.claude/tab-status/<sha256(project path)[0..16]>, content = event
//    label (working | waiting | stop).
// 3. Each window watches only its own file. When it shows up and the window
//    is unfocused -> marker in the title + macOS banner with sound
//    (terminal-notifier, osascript fallback). Focus -> marker cleared.
//    Focused windows get neither marker nor banner: whoever is watching
//    doesn't need a ping.

const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STATUS_DIR = path.join(os.homedir(), '.claude', 'tab-status');
// Mirror of the shellTasksKeepWorking setting for the Stop hook (see there)
const SHELL_FLAG = path.join(STATUS_DIR, '.shell-keeps-working');
// Mute flag: holds an epoch-ms timestamp until which banners and sounds stay
// silent. Lives in the shared status dir so one command mutes every window.
const MUTE_FLAG = path.join(STATUS_DIR, '.muted-until');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CONTEXT_KEY = 'claudeRadar.status';
const TITLE_VAR = '${claudeRadarStatus}';
const LABELS = ['working', 'waiting', 'stop'];
const PEEK_MS = 1000; // focused window: show an attention marker briefly, then hide it

// One hook per event, each writes an event label into the marker file.
// MARKER_F computes $f = this project's marker file path, identical to
// markerFile() below: sha256 over the realpath-resolved project path
// (cd + pwd -P, so symlink variants of the same folder hash alike),
// first 16 hex chars.
const MARKER_F = `d="$HOME/.claude/tab-status"; /bin/mkdir -p "$d"; p="\${CLAUDE_PROJECT_DIR:-$PWD}"; p="$(cd "$p" 2>/dev/null && pwd -P || printf '%s' "$p")"; f="$d/$(printf '%s' "$p" | /usr/bin/shasum -a 256 | /usr/bin/cut -c1-16)"`;

// Write the marker atomically (tmp + rename): the reading window must never
// catch a half-written marker. $$ = PID of the hook shell; collides neither
// with hooks firing in parallel nor with the windows' claim files.
const WRITE_F = `> "$f.tmp.$$" && /bin/mv -f "$f.tmp.$$" "$f"`;

// Fixed-label hooks: simply write their label.
const writeMarker = (label) => `${MARKER_F}; printf '%s' "${label}" ${WRITE_F}`;

// The Stop hook is conditional. If background work is still running when the
// turn ends (the Workflow tool, run_in_background Bash, or a background
// agent), it shows up in the Stop payload (stdin) under .background_tasks[]
// with status "running" | "in_progress" | "pending". Then write 'working'
// instead of 'stop', otherwise the tab would falsely show 🟢 "done" while
// the background keeps working for minutes. Only when no task is active
// anymore does 'stop' win. jq preferred; else python3 (virtually always
// present on dev Macs via the Xcode CLT); with neither, behavior stays as
// before ('stop', no regression risk). Deliberately no plain-grep fallback:
// the payload contains .last_assistant_message as free text that can contain
// exactly these status words -> only .background_tasks must be parsed.
//
// Type filter: tasks carry .type ('shell' | 'subagent' | 'workflow' |
// 'monitor' | ...). Subagents/workflows/monitors are finite work that wakes
// the session again -> they keep 'working'. 'shell' is ambiguous (build or
// long-lived server) and therefore does NOT count as work by default, else a
// dev/preview server started by Claude would hold 💬 indefinitely and
// suppress the done banner. To make shell tasks count, turn on the
// shellTasksKeepWorking setting; the extension mirrors it as a flag file in
// the status dir (the hook string stays static, the toggle takes effect
// immediately without reinstalling hooks). If .type is missing (older
// Claude Code version), the task counts as work -> pre-filter behavior.
const ACTIVE_JQ = `((.status // .state) as $s | $s=="running" or $s=="in_progress" or $s=="pending") and ($a=="1" or .type != "shell")`;
const ACTIVE_PY = `import sys,json,os;d=json.load(sys.stdin);ts=d.get("background_tasks") or [];print("Y" if any((t.get("status") or t.get("state")) in ("running","in_progress","pending") and (os.environ.get("A")=="1" or t.get("type")!="shell") for t in ts) else "N")`;
const stopMarker =
  `${MARKER_F}; in="$(cat)"; lbl=stop; a=0; [ -f "$d/.shell-keeps-working" ] && a=1; ` +
  `if command -v jq >/dev/null 2>&1; then printf '%s' "$in" | jq -e --arg a "$a" 'any((.background_tasks // [])[]?; ${ACTIVE_JQ})' >/dev/null 2>&1 && lbl=working; ` +
  `elif command -v python3 >/dev/null 2>&1; then printf '%s' "$in" | A="$a" python3 -c '${ACTIVE_PY}' 2>/dev/null | grep -q Y && lbl=working; fi; ` +
  `printf '%s' "$lbl" ${WRITE_F}`;

const HOOK_SPECS = [
  { event: 'UserPromptSubmit', matcher: '', command: writeMarker('working') }, // working (purely visual, no banner/sound)
  { event: 'Notification', matcher: '', command: writeMarker('waiting') }, // needs you (permission/idle)
  { event: 'PermissionRequest', matcher: '', command: writeMarker('waiting') },
  // A question counts as "needs you" (= waiting); its own hook, because
  // AskUserQuestion fires neither Stop nor Notification.
  { event: 'PreToolUse', matcher: 'AskUserQuestion', command: writeMarker('waiting') },
  // After a question is answered, Claude keeps working without a new
  // UserPromptSubmit firing -> back to 'working' here (⚠️ -> 💬).
  { event: 'PostToolUse', matcher: 'AskUserQuestion', command: writeMarker('working') },
  { event: 'Stop', matcher: '', command: stopMarker }, // done - unless background work is still running
];

// Binaries detected on activation (Apple Silicon / Intel)
let notifierPath;
let codeCliPath;

function detectBinaries() {
  notifierPath = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find(
    (p) => fs.existsSync(p)
  );
  codeCliPath = ['/usr/local/bin/code', '/opt/homebrew/bin/code'].find((p) => fs.existsSync(p));
}

// For terminal-notifier's -execute string (runs in a shell)
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function markerFile() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  let p = folders[0].uri.fsPath;
  try {
    p = fs.realpathSync(p);
  } catch {
    /* folder unresolvable (e.g. just deleted): hash it unresolved */
  }
  const hash = crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
  return path.join(STATUS_DIR, hash);
}

// label: 'working' | 'waiting' | 'stop' sets the matching marker,
// null removes it.
function setMarker(label) {
  let marker = '';
  if (label) {
    const cfg = vscode.workspace.getConfiguration('claudeRadar');
    const symbol = (
      label === 'waiting' ? cfg.get('markerWaiting', '⚠️')
      : label === 'working' ? cfg.get('markerWorking', '💬')
      : cfg.get('markerDone', '🟢')
    ).trim();
    // We add the separating space ourselves so it doesn't have to be
    // maintained in the settings (empty symbol -> no prefix at all).
    marker = symbol ? symbol + ' ' : '';
  }
  return vscode.commands.executeCommand('setContext', CONTEXT_KEY, marker);
}

// Muted (and not yet expired)? Markers keep updating, only banner/sound pause.
function isMuted() {
  try {
    const until = Number(fs.readFileSync(MUTE_FLAG, 'utf8'));
    if (Date.now() < until) return true;
    fs.unlinkSync(MUTE_FLAG); // expired: clean up so the check stays cheap
  } catch {
    /* no flag or unreadable: not muted */
  }
  return false;
}

function notify(label) {
  const cfg = vscode.workspace.getConfiguration('claudeRadar');
  if (!cfg.get('banner', true)) return;
  if (isMuted()) return;
  detectBinaries(); // lazy: also picks up a terminal-notifier installed after startup

  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const projectName = folder ? folder.name : 'VS Code';
  const projectPath = folder ? folder.uri.fsPath : '';
  const done = label === 'stop';
  const subtitle = done ? 'Done' : 'Needs you';
  const sound = done ? cfg.get('soundDone', 'Glass') : cfg.get('soundWaiting', 'Basso');

  if (notifierPath) {
    // Project name prominent as the title, status below. The Radar icon
    // shows on the banner's right (-contentImage); the left app icon can't
    // be replaced on modern macOS without shipping a signed app bundle.
    const args = [
      '-title', projectName,
      '-subtitle', subtitle,
      '-message', 'Claude Code',
      '-group', 'claude-radar:' + projectPath, // replaces the previous banner of the same project
      '-contentImage', path.join(__dirname, 'icon.png'),
    ];
    if (sound) args.push('-sound', sound);
    if (codeCliPath && projectPath) {
      // Clicking the banner focuses the right window
      args.push('-execute', `${shq(codeCliPath)} ${shq(projectPath)}`);
    } else {
      args.push('-activate', 'com.microsoft.VSCode');
    }
    execFile(notifierPath, args, () => {});
  } else {
    // Fallback: message + sound, but not clickable
    const script =
      `display notification "Claude Code" ` +
      `with title ${JSON.stringify(projectName)} subtitle ${JSON.stringify(subtitle)}` +
      (sound ? ` sound name ${JSON.stringify(sound)}` : '');
    execFile('/usr/bin/osascript', ['-e', script], () => {});
  }
}

// Mirror the setting into the status dir as a flag file so the (static)
// Stop hook can read it. Application scope, i.e. exactly one value per user;
// every window mirrors the same state.
function syncShellFlag() {
  const on = vscode.workspace.getConfiguration('claudeRadar').get('shellTasksKeepWorking', false);
  try {
    if (on) fs.writeFileSync(SHELL_FLAG, '');
    else fs.unlinkSync(SHELL_FLAG);
  } catch {
    /* unlink without the file, fine */
  }
}

// Remove files of sessions no VS Code window ever picked up (e.g. Claude
// CLI in unrelated directories) after 24 h.
function cleanupStale() {
  let names;
  try {
    names = fs.readdirSync(STATUS_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (name.startsWith('.')) continue; // config flags, not markers
    const f = path.join(STATUS_DIR, name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
    } catch {
      /* file may vanish concurrently, fine */
    }
  }
}

function titleHasVariable() {
  const title = vscode.workspace.getConfiguration('window').get('title', '');
  return title.includes(TITLE_VAR);
}

async function setupTitle() {
  const cfg = vscode.workspace.getConfiguration('window');
  const info = cfg.inspect('title');
  const base = (info && (info.globalValue ?? info.defaultValue)) || '';
  if (base.includes(TITLE_VAR)) {
    vscode.window.showInformationMessage('window.title already has ' + TITLE_VAR + '.');
    return;
  }
  await cfg.update('title', TITLE_VAR + base, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Done. The marker now shows at the left of the title and tab.'
  );
}

function hooksInstalled() {
  try {
    const json = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Compare per event, not just the overall set of commands: otherwise a
    // new hook with an already-known label would go unnoticed (e.g.
    // PostToolUse -> working, where 'working' already comes from
    // UserPromptSubmit), and a leftover hook from an older version wouldn't
    // be detected. Work on the parsed commands, not the raw file text (JSON
    // escaping of the quotes). Identical commands per event collapse in the Set.
    const byEvent = (pairs) => {
      const m = {};
      for (const [event, cmd] of pairs) (m[event] = m[event] || new Set()).add(cmd);
      return m;
    };
    const expected = byEvent(HOOK_SPECS.map((s) => [s.event, s.command]));
    const installed = byEvent(
      Object.entries(json.hooks || {}).flatMap(([event, groups]) =>
        (groups || [])
          .flatMap((g) => (g.hooks || []).map((h) => String(h.command || '')))
          .filter((c) => c.includes('tab-status'))
          .map((c) => [event, c])
      )
    );
    const events = new Set([...Object.keys(expected), ...Object.keys(installed)]);
    for (const event of events) {
      const exp = expected[event] || new Set();
      const ins = installed[event] || new Set();
      if (exp.size !== ins.size || ![...exp].every((c) => ins.has(c))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Are any of our own hooks installed at all (possibly from an older
// version)? Distinguishes "outdated, needs update" from "never installed".
function hasOwnHooks() {
  try {
    return fs.readFileSync(SETTINGS_PATH, 'utf8').includes('tab-status');
  } catch {
    return false;
  }
}

async function installHooks(auto = false) {
  let json = {};
  let existed = false;
  try {
    json = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    existed = true;
  } catch (e) {
    if (fs.existsSync(SETTINGS_PATH)) {
      vscode.window.showErrorMessage(
        "~/.claude/settings.json isn't valid JSON, so hooks weren't installed: " + e.message
      );
      return;
    }
  }
  json.hooks = json.hooks || {};
  const before = JSON.stringify(json.hooks);
  for (const spec of HOOK_SPECS) {
    // Remove our own stale entries (upgrade), then insert fresh
    const groups = (json.hooks[spec.event] = json.hooks[spec.event] || []).filter(
      (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('tab-status'))
    );
    groups.push({ matcher: spec.matcher, hooks: [{ type: 'command', command: spec.command }] });
    json.hooks[spec.event] = groups;
  }
  if (JSON.stringify(json.hooks) === before) {
    // Stay quiet during the automatic reconcile; only the manually invoked
    // command reports back when there's nothing to do.
    if (!auto) vscode.window.showInformationMessage('Hooks are already up to date.');
    return;
  }
  if (existed) fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.claude-radar.bak');
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  // Write atomically so a crash mid-write can't corrupt the Claude config
  const tmp = SETTINGS_PATH + '.claude-radar.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_PATH);
  vscode.window.showInformationMessage(
    auto ? 'Hooks updated. Backup saved.' : 'Hooks installed. Backup saved.'
  );
}

// Uninstall path: VS Code runs no extension code on uninstall, so the user
// removes the hooks beforehand via this command. Only our own (tab-status)
// hooks; others stay.
async function removeHooks() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    vscode.window.showInformationMessage('No Claude settings found, nothing to remove.');
    return;
  }
  const before = JSON.stringify(json.hooks || {});
  for (const event of Object.keys(json.hooks || {})) {
    json.hooks[event] = (json.hooks[event] || []).filter(
      (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('tab-status'))
    );
    if (json.hooks[event].length === 0) delete json.hooks[event];
  }
  if (JSON.stringify(json.hooks || {}) === before) {
    vscode.window.showInformationMessage('No Radar for Claude Code hooks to remove.');
    return;
  }
  fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.claude-radar.bak');
  const tmp = SETTINGS_PATH + '.claude-radar.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_PATH);
  vscode.window.showInformationMessage('Radar for Claude Code hooks removed. Backup saved.');
}

// Setup is required: without the title variable and the hooks, no marker can
// ever appear. Re-offer on activation until it's done, rate-limited to once
// per hour so several windows don't stack dialogs, with a permanent opt-out.
async function maybeOfferSetup(context) {
  if (context.globalState.get('setupDeclined')) return;
  if (titleHasVariable() && hooksInstalled()) return;
  const last = context.globalState.get('setupOfferedAt', 0);
  if (Date.now() - last < 60 * 60 * 1000) return;
  await context.globalState.update('setupOfferedAt', Date.now());
  const pick = await vscode.window.showInformationMessage(
    'Radar needs a one-time setup: the status variable in window.title and the Claude hooks in ~/.claude/settings.json (a backup is written). Without it, no marker will show.',
    'Set up',
    'Not now',
    "Don't ask again"
  );
  if (pick === 'Set up') {
    if (!titleHasVariable()) await setupTitle();
    if (!hooksInstalled()) await installHooks();
  } else if (pick === "Don't ask again") {
    await context.globalState.update('setupDeclined', true);
  }
}

// Banners jump into the right window only with terminal-notifier; the
// osascript fallback isn't clickable. Once the main setup is done, offer the
// Homebrew install. Same rate limit and opt-out as the setup offer.
async function maybeOfferNotifier(context) {
  if (context.globalState.get('notifierDeclined')) return;
  if (!titleHasVariable() || !hooksInstalled()) return; // one thing at a time
  detectBinaries();
  if (notifierPath) return;
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p));
  if (!brew) return; // no Homebrew, nothing to offer; the README covers it
  const last = context.globalState.get('notifierOfferedAt', 0);
  if (Date.now() - last < 60 * 60 * 1000) return;
  await context.globalState.update('notifierOfferedAt', Date.now());
  const pick = await vscode.window.showInformationMessage(
    "Optional: install terminal-notifier (Homebrew) so a click on a banner jumps into the right window. Without it, banners show but aren't clickable.",
    'Install',
    'Not now',
    "Don't ask again"
  );
  if (pick === 'Install') {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Installing terminal-notifier…' },
      () =>
        new Promise((resolve) => {
          execFile(brew, ['install', 'terminal-notifier'], (err, stdout, stderr) => {
            if (err) {
              vscode.window.showErrorMessage(
                'Homebrew failed: ' + String(stderr || err.message).slice(-300)
              );
            } else {
              vscode.window.showInformationMessage(
                'terminal-notifier installed. Banners are now clickable.'
              );
            }
            resolve();
          });
        })
    );
  } else if (pick === "Don't ask again") {
    await context.globalState.update('notifierDeclined', true);
  }
}

async function activate(context) {
  // macOS only: banners (terminal-notifier/osascript), system sounds, native
  // tabs, and the Unix tools in the hook only exist here. Exit cleanly
  // otherwise, with a one-time notice.
  if (process.platform !== 'darwin') {
    // The commands from package.json appear in the palette here too; without
    // registration a click throws "command not found" instead of an answer.
    const notice = () => vscode.window.showInformationMessage('Radar for Claude Code is macOS only.');
    for (const cmd of ['clear', 'installHooks', 'removeHooks', 'setupTitle', 'mute', 'unmute']) {
      context.subscriptions.push(vscode.commands.registerCommand('claudeRadar.' + cmd, notice));
    }
    if (!context.globalState.get('macosOnlyNoticeShown')) {
      context.globalState.update('macosOnlyNoticeShown', true);
      notice();
    }
    return;
  }

  await vscode.commands.executeCommand('registerWindowTitleVariable', 'claudeRadarStatus', CONTEXT_KEY);
  await setMarker(null);

  fs.mkdirSync(STATUS_DIR, { recursive: true });
  syncShellFlag();
  // Cleanup doesn't have to run in the activation path
  const cleanupTimer = setTimeout(cleanupStale, 5000);
  context.subscriptions.push({ dispose: () => clearTimeout(cleanupTimer) });

  // Current state of this window. The marker is derived from state + focus:
  // 'working' is a lasting state (survives focus, reappears on unfocus),
  // the other labels are events (peeked briefly when focused, then
  // acknowledged).
  let currentLabel = null;
  let peekTimer; // hides the briefly shown marker in the active window again
  context.subscriptions.push({ dispose: () => clearTimeout(peekTimer) });

  const file = markerFile();
  if (file) {
    const check = () => {
      // Claim the file atomically: with two windows on the same project,
      // exactly one processes the event
      const claim = file + '.' + process.pid;
      try {
        fs.renameSync(file, claim);
      } catch {
        return; // file gone or another window was faster
      }
      let label = '';
      try {
        label = fs.readFileSync(claim, 'utf8').trim();
      } finally {
        try {
          fs.unlinkSync(claim);
        } catch {
          /* already gone, fine */
        }
      }
      if (!LABELS.includes(label)) label = 'stop'; // unexpected content -> treat as done
      currentLabel = label;
      clearTimeout(peekTimer); // a running peek must never overwrite a new event
      // 'working' is a lasting state and always visible (even in the active
      // window), never with banner/sound -> no flicker on focus changes
      // while Claude is working.
      if (label === 'working') {
        setMarker('working');
        return;
      }
      // waiting/stop are attention events. In the focused window, "peek":
      // show the marker ~1 s, then hide it, without banner/sound. The user
      // sees "needs you/done" once, then the tab is quiet again.
      // Unfocused: persistent marker + banner.
      if (vscode.window.state.focused) {
        currentLabel = null; // counts as seen
        setMarker(label);
        peekTimer = setTimeout(() => {
          if (vscode.window.state.focused) setMarker(null);
        }, PEEK_MS);
        return;
      }
      setMarker(label);
      notify(label);
    };
    const ownName = path.basename(file);
    let debounce;
    const watcher = fs.watch(STATUS_DIR, (eventType, filename) => {
      // Only our own project wakes this window; if the filename is missing
      // (macOS rarely omits it) check to be safe
      if (filename && filename !== ownName) return;
      clearTimeout(debounce);
      debounce = setTimeout(check, 50);
    });
    // Without an error handler, a watcher error (e.g. directory deleted)
    // would hit the extension host process as an unhandled event
    watcher.on('error', () => {});
    context.subscriptions.push({
      dispose: () => {
        clearTimeout(debounce);
        watcher.close();
      },
    });
    check(); // the file may already exist (e.g. window reload)
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeRadar.shellTasksKeepWorking')) syncShellFlag();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      clearTimeout(peekTimer); // a running peek is obsolete after a focus change
      if (s.focused) {
        // 'working' stays visible (Claude keeps working, no flicker);
        // waiting/stop count as seen once focused.
        if (currentLabel === 'working') {
          setMarker('working');
        } else {
          setMarker(null);
          currentLabel = null;
        }
      } else {
        // Unfocusing: show the current state (working persists, acknowledged ones null).
        setMarker(currentLabel);
      }
    }),
    vscode.commands.registerCommand('claudeRadar.clear', () => setMarker(null)),
    vscode.commands.registerCommand('claudeRadar.installHooks', () => installHooks()),
    vscode.commands.registerCommand('claudeRadar.removeHooks', removeHooks),
    vscode.commands.registerCommand('claudeRadar.setupTitle', setupTitle),
    vscode.commands.registerCommand('claudeRadar.mute', () => {
      fs.writeFileSync(MUTE_FLAG, String(Date.now() + 60 * 60 * 1000));
      vscode.window.showInformationMessage(
        'Banners and sounds muted for 1 hour. The title markers stay on.'
      );
    }),
    vscode.commands.registerCommand('claudeRadar.unmute', () => {
      const wasMuted = isMuted();
      try {
        fs.unlinkSync(MUTE_FLAG);
      } catch {
        /* already gone, fine */
      }
      vscode.window.showInformationMessage(
        wasMuted ? 'Banners and sounds are back on.' : "Banners weren't muted."
      );
    })
  );

  // Keep our own hooks current on activation: if some are installed but
  // outdated (an event is missing after an extension update), reconcile
  // silently. With no own hooks present, the first-time installation
  // deliberately stays with the setup dialog (no unasked config change).
  (async () => {
    if (hasOwnHooks() && !hooksInstalled()) await installHooks(true);
    await maybeOfferSetup(context);
    await maybeOfferNotifier(context);
  })();
}

function deactivate() {
  return vscode.commands.executeCommand('setContext', CONTEXT_KEY, '');
}

module.exports = { activate, deactivate };
