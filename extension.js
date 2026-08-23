// Radar for Claude Code
//
// How it works:
// 1. Registers the window-title variable ${claudeRadarStatus} (VS Code >= 1.93,
//    "registerWindowTitleVariable" command); its value comes from a context
//    key. In-memory only, no per-window settings writes.
// 2. Claude Code hooks write a marker file per event to
//    ~/.claude/tab-status/<sha256(project path)[0..16]>, content = event
//    label (working | waiting | stop).
// 3. Each window watches only its own file. When an attention event
//    (needs you | done) shows up and the window is unfocused -> marker in
//    the title + macOS banner with sound (terminal-notifier, osascript
//    fallback). Focus -> marker cleared. A focused window flashes those
//    events for a second and never rings: whoever is watching doesn't need
//    a ping. 'working' is a lasting state, so it stays visible there.

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
// One file per running Claude session, holding at least { pid, sessionId, cwd }
// (verified against 2.1.241). See liveSessionsHere() for what Radar reads it for.
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CONTEXT_KEY = 'claudeRadar.status';
const TITLE_VAR = '${claudeRadarStatus}';
// 'prompt' is 'working' with a reset clock (see check()), not a state of its own.
const LABELS = ['prompt', 'working', 'waiting', 'stop'];
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
  // A new prompt shows 'working' like every other event, but with a fresh
  // clock: its own label separates "you just sent something" from the
  // PostToolUse 'working' repeats, which must not reset the time (see
  // check()). Without it the elapsed time kept running across an interrupted
  // turn - Esc fires no hook at all (verified against Claude Code 2.1.209:
  // no Stop, no Notification, nothing), so the old 'working' from the
  // aborted turn survived into the next one and the title showed minutes
  // that had never been worked.
  { event: 'UserPromptSubmit', matcher: '', command: writeMarker('prompt') }, // working, clock restarted (no banner/sound)
  // Notification fires for more than "needs you": the matcher filters on
  // .notification_type, so list the types that actually wait for the user.
  // Without it, auth_success, elicitation_complete/-response and
  // agent_completed each raised ⚠️ with a Basso - a false alarm for
  // something that had just finished on its own.
  {
    event: 'Notification',
    matcher: 'permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input',
    command: writeMarker('waiting'),
  },
  { event: 'PermissionRequest', matcher: '', command: writeMarker('waiting') },
  // A question counts as "needs you" (= waiting); its own hook, because
  // AskUserQuestion fires neither Stop nor Notification.
  { event: 'PreToolUse', matcher: 'AskUserQuestion', command: writeMarker('waiting') },
  // Every completed tool call flips back to 'working' (⚠️ -> 💬): after an
  // answered question or a granted permission Claude keeps working without a
  // new UserPromptSubmit firing. Only AskUserQuestion has a post event of its
  // own; granted permissions have none, so with a matcher limited to
  // AskUserQuestion the title stayed empty for the rest of a long run (e.g.
  // a multi-agent audit) once a permission prompt had been acknowledged.
  // The final Stop still wins: it fires after the last PostToolUse.
  { event: 'PostToolUse', matcher: '', command: writeMarker('working') },
  { event: 'Stop', matcher: '', command: stopMarker }, // done - unless background work is still running
];

// Binaries detected on activation (Apple Silicon / Intel)
let notifierPath;
let codeCliPath;

function detectBinaries() {
  notifierPath = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'].find(
    (p) => fs.existsSync(p)
  );
  // Prefer the CLI inside the running editor's own bundle (appRoot =
  // <bundle>.app/Contents/Resources/app, its bin/ ships the CLI): it exists
  // without the user ever installing the shell command, and it always opens
  // THIS editor, also on forks (Insiders ships code-insiders, Cursor ships
  // cursor). The *-tunnel binaries there are not window CLIs. Fall back to
  // the classic shell-command locations.
  let hostCli;
  try {
    const binDir = path.join(vscode.env.appRoot, 'bin');
    const name = fs.readdirSync(binDir).filter((n) => !n.includes('tunnel')).sort()[0];
    if (name) hostCli = path.join(binDir, name);
  } catch {
    /* no bin dir (unexpected packaging): fall back */
  }
  codeCliPath = hostCli || ['/usr/local/bin/code', '/opt/homebrew/bin/code'].find((p) => fs.existsSync(p));
}

// Bundle id of the running editor, for the -activate fallback when no CLI
// was found. Detected once, async; until then the safe default. Hardcoding
// com.microsoft.VSCode would focus the wrong app on Insiders or Cursor.
let bundleId = 'com.microsoft.VSCode';

function detectBundleId() {
  const app = vscode.env.appRoot.split('.app/')[0] + '.app';
  execFile(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Contents', 'Info.plist')],
    (err, stdout) => {
      if (!err && String(stdout).trim()) bundleId = String(stdout).trim();
    }
  );
}

// For terminal-notifier's -execute string (runs in a shell)
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Realpath-resolved path of the first workspace folder. Everything
// project-scoped keys off this: the marker file, the transcript folder, and
// the cwd match against running sessions. Symlink variants of the same folder
// therefore resolve alike. Unresolvable (just deleted) falls back to the raw
// path, so a marker still has a stable name.
function projectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const p = folders[0].uri.fsPath;
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// How Claude Code names its transcript folders: every non-alphanumeric UTF-16
// unit becomes '-' (verified against real transcript dirs, including __ and
// emoji paths).
const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function markerFile() {
  const p = projectRoot();
  if (!p) return undefined;
  const hash = crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
  return path.join(STATUS_DIR, hash);
}

// Epoch ms of the transition into 'working'; null outside of it. Feeds the
// opt-in elapsed time in the marker (💬 14m).
let workingSince = null;

// Live count of running subagents (💬 14m 🤖8). Claude Code keeps one
// transcript per subagent under ~/.claude/projects/<slug>/<session>/subagents/
// (workflow agents one level deeper, in workflows/<runId>/). A transcript
// appended to within AGENT_ACTIVE_MS counts as a running agent: agents write
// on every message, so longer silence means finished - or stuck in one long
// tool call, which is why the window is generous rather than tight (the
// count may briefly dip while an agent sits in a long build). Read-only
// polling instead of hook events: SubagentStop can be missed (Esc, kill),
// and a missed event would leave a counter stuck forever; mtimes self-heal.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const AGENT_ACTIVE_MS = 120000;
const AGENT_POLL_MS = 10000;
let agentCount = 0;

function agentTranscriptRoot() {
  const p = projectRoot();
  return p ? path.join(PROJECTS_DIR, slugFor(p)) : undefined;
}

function countActiveAgents() {
  const root = agentTranscriptRoot();
  if (!root) return 0;
  const cutoff = Date.now() - AGENT_ACTIVE_MS;
  let sessions;
  try {
    sessions = fs.readdirSync(root);
  } catch {
    return 0; // project has no transcripts yet
  }
  let n = 0;
  for (const session of sessions) {
    // Non-session entries (the *.jsonl transcripts themselves, memory/) fail
    // the readdirs below and fall through; cheaper than stat-filtering first.
    const sub = path.join(root, session, 'subagents');
    const dirs = [sub];
    try {
      for (const wf of fs.readdirSync(path.join(sub, 'workflows'))) {
        dirs.push(path.join(sub, 'workflows', wf));
      }
    } catch {
      /* no workflow agents in this session, fine */
    }
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // no subagents in this session
      }
      for (const name of names) {
        if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
        try {
          if (fs.statSync(path.join(dir, name)).mtimeMs > cutoff) n++;
        } catch {
          /* vanished mid-scan, fine */
        }
      }
    }
  }
  return n;
}

// Refresh agentCount; true when it changed (caller then redraws the marker).
function updateAgentCount() {
  const n = countActiveAgents();
  if (n === agentCount) return false;
  agentCount = n;
  return true;
}

// Live sessions and their transcripts. Two things Radar cannot learn from
// hooks come from here, both read-only and both only while a marker shows:
//
// 1. Liveness. A hook fires only while Claude runs. Dies the process mid-turn
//    (crash, closed terminal, window reload), no Stop ever arrives and the
//    marker hangs forever, running clock included. A pid that no longer
//    answers proves nobody is working in this project.
// 2. The transcript. sessionId names the JSONL under PROJECTS_DIR, which
//    records two events no hook reports: the Esc interrupt (Claude Code fires
//    nothing at all for it) and a failed tool call.

// Sessions of this project whose process still answers. undefined means "can
// not tell": no session files at all, i.e. an older Claude Code without the
// feature, or simply nothing running anywhere. Callers must then leave the
// marker alone - clearing on an absent feature would wipe every marker. An
// empty array is a real answer: sessions exist, none of them here.
function liveSessionsHere(root) {
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return undefined; // no sessions dir
  }
  const here = [];
  let sawAny = false;
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    sawAny = true;
    try {
      process.kill(Number(m[1]), 0); // signal 0 only probes, it never signals
    } catch (e) {
      // EPERM means alive but owned by someone else; anything else is gone.
      // A recycled pid can make a dead session look alive, which only ever
      // leaves a marker standing - the harmless direction.
      if (e.code !== 'EPERM') continue;
    }
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
    } catch {
      continue; // half-written or not JSON
    }
    if (typeof d.sessionId !== 'string' || typeof d.cwd !== 'string') continue;
    // Resolve the session's cwd the same way projectRoot() resolves ours: a
    // project opened through a symlink otherwise never matches, and a session
    // wrongly counted as gone takes a live marker with it.
    let cwd = d.cwd;
    try {
      cwd = fs.realpathSync(cwd);
    } catch {
      /* directory gone; compare what the session reported */
    }
    // Prefix, not equality: Claude may have been started in a subfolder while
    // the marker hangs on the project root (the hook uses CLAUDE_PROJECT_DIR).
    // Deliberately no filter on d.entrypoint, or sessions started in a plain
    // terminal would count as dead and lose their marker.
    if (cwd === root || cwd.startsWith(root + path.sep)) here.push(d);
  }
  return sawAny ? here : undefined;
}

// Bytes already read per transcript. A file seen for the first time is only
// measured, never scanned: its history holds interrupts and errors from
// earlier turns that must not fire now.
const tailOffsets = new Map();
// Set when the transcript shows the turn was interrupted with Esc.
let sawInterrupt = false;
// True while the most recent tool call failed. Measured over 1464 real turns:
// "the last tool_result was an error" marks 2 %, while "any error somewhere in
// the turn" marks 6 % - mostly failures Claude recovered from in the same
// turn, which is exactly what Radar must not report.
let lastToolFailed = false;

function scanTranscriptLine(line) {
  // Cheap pre-filter. tool_result also has to pass when it succeeded, that is
  // what resets lastToolFailed.
  if (!line.includes('tool_result') && !line.includes('Request interrupted')) return;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  if (d.type !== 'user') return;
  const content = d.message && d.message.content;
  if (!Array.isArray(content)) return; // a typed prompt is a plain string
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    // Checking the structure matters: the same words show up inside tool
    // output whenever anyone greps for them, so a plain substring scan would
    // fire on that. Verified against the real transcripts: the interrupt is
    // always its own text block on a user line.
    if (b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted by user')) {
      sawInterrupt = true;
    }
    if (b.type === 'tool_result') lastToolFailed = b.is_error === true;
  }
}

// Read what is new in this project's transcripts and fold it into the two
// flags above. Only whole lines are consumed: Claude may be mid-write, and
// advancing past a partial line would drop it for good.
function scanTranscripts(sessions) {
  for (const s of sessions) {
    const file = path.join(PROJECTS_DIR, slugFor(s.cwd), s.sessionId + '.jsonl');
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue; // no transcript yet
    }
    const seen = tailOffsets.get(file);
    if (seen === undefined || size < seen) {
      tailOffsets.set(file, size); // first sight, or replaced: baseline only
      continue;
    }
    if (size === seen) continue;
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        buf = Buffer.allocUnsafe(size - seen);
        fs.readSync(fd, buf, 0, buf.length, seen);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    // Cut on the last newline in the raw bytes, so a chunk never starts in the
    // middle of a multi-byte character.
    const nl = buf.lastIndexOf(0x0a);
    if (nl === -1) continue; // no complete line yet, keep the offset
    tailOffsets.set(file, seen + nl + 1);
    for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
      if (line) scanTranscriptLine(line);
    }
  }
}

// '' below one minute, then '14m', from an hour on '1h05'.
function elapsedLabel(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  if (m < 1) return '';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

// label: 'working' | 'waiting' | 'stop' | 'error' sets the matching marker,
// null removes it. 'error' is the only one no hook writes: it is derived in
// check() from the transcript when a turn ended on a failed tool call.
function setMarker(label) {
  let marker = '';
  if (label) {
    const cfg = vscode.workspace.getConfiguration('claudeRadar');
    const symbol = (
      label === 'waiting' ? cfg.get('markerWaiting', '⚠️')
      : label === 'working' ? cfg.get('markerWorking', '💬')
      : label === 'error' ? cfg.get('markerError', '🔴')
      : cfg.get('markerDone', '🟢')
    ).trim();
    let time = '';
    if (label === 'working' && workingSince && cfg.get('showWorkingTime', true)) {
      const t = elapsedLabel(workingSince);
      if (t) time = ' ' + t;
    }
    let agents = '';
    if (label === 'working' && agentCount > 0) {
      const agentSymbol = cfg.get('markerAgents', '🤖').trim();
      if (agentSymbol) agents = ' ' + agentSymbol + agentCount;
    }
    // We add the separating space ourselves so it doesn't have to be
    // maintained in the settings (empty symbol -> no prefix at all).
    marker = symbol ? symbol + time + agents + ' ' : '';
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

// ranFor: elapsed label of the finished run ('14m'), empty below a minute
// or when the state was never 'working'.
function notify(label, ranFor = '') {
  const cfg = vscode.workspace.getConfiguration('claudeRadar');
  if (!cfg.get('banner', true)) return;
  if (isMuted()) return;
  detectBinaries(); // lazy: also picks up a terminal-notifier installed after startup

  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const projectName = folder ? folder.name : 'VS Code';
  const projectPath = folder ? folder.uri.fsPath : '';
  const failed = label === 'error';
  const done = label === 'stop';
  const subtitle = failed
    ? ranFor ? 'Failed after ' + ranFor : 'Failed'
    : done
      ? ranFor ? 'Done after ' + ranFor : 'Done'
      : 'Needs you';
  // A failed turn wants you more than a finished one does, so it borrows the
  // attention sound rather than the friendly one.
  const sound = failed
    ? cfg.get('soundError', 'Basso')
    : done
      ? cfg.get('soundDone', 'Glass')
      : cfg.get('soundWaiting', 'Basso');

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
      args.push('-activate', bundleId);
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
  const info = cfg.inspect('title') || {};
  // Write into the scope that is actually in force: a window.title in
  // .code-workspace or .vscode/settings.json beats the global one, so writing
  // to Global there would report success while the variable never takes
  // effect - and the setup dialog would keep coming back.
  const wsValue = info.workspaceFolderValue ?? info.workspaceValue;
  const inWorkspace = wsValue !== undefined;
  const base = (inWorkspace ? wsValue : info.globalValue ?? info.defaultValue) || '';
  if (base.includes(TITLE_VAR)) {
    vscode.window.showInformationMessage('window.title already has ' + TITLE_VAR + '.');
    return;
  }
  await cfg.update(
    'title',
    TITLE_VAR + base,
    inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(
    'Done. The marker now shows at the left of the title and tab.' +
      (inWorkspace ? ' Added to this workspace, which overrides your global window.title.' : '')
  );
}

function hooksInstalled() {
  try {
    const json = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Compare per event, not just the overall set of commands: otherwise a
    // new hook with an already-known label would go unnoticed (e.g.
    // PostToolUse -> working, where 'working' already comes from
    // UserPromptSubmit), and a leftover hook from an older version wouldn't
    // be detected. The matcher is part of the comparison: v1.0.4 widened
    // PostToolUse from 'AskUserQuestion' to '' with an unchanged command; a
    // command-only comparison would miss that upgrade. Work on the parsed
    // values, not the raw file text (JSON escaping of the quotes). Identical
    // matcher+command pairs per event collapse in the Set.
    const byEvent = (pairs) => {
      const m = {};
      for (const [event, key] of pairs) (m[event] = m[event] || new Set()).add(key);
      return m;
    };
    const expected = byEvent(HOOK_SPECS.map((s) => [s.event, s.matcher + '\u0000' + s.command]));
    const installed = byEvent(
      Object.entries(json.hooks || {}).flatMap(([event, groups]) =>
        (groups || []).flatMap((g) =>
          (g.hooks || [])
            .map((h) => String(h.command || ''))
            .filter((c) => c.includes('tab-status'))
            .map((c) => [event, String(g.matcher || '') + '\u0000' + c])
        )
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

// Drop only our own entries from a matcher group, never the whole group:
// users put their own commands into the same group (matcher '' is the
// canonical form Claude Code itself writes), and those have to survive an
// update. Groups that end up empty are the ones we created, so they go.
function stripOwnHooks(groups) {
  return (groups || [])
    .map((g) => ({
      ...g,
      hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes('tab-status')),
    }))
    .filter((g) => g.hooks.length > 0);
}

// Write ~/.claude/settings.json atomically (tmp + rename) without changing
// what the file is. rename(2) replaces a symlink instead of following it, so
// resolve the real target first (dotfiles repos link this file), and carry
// the existing permissions over: Claude Code creates it with 600, and a
// default tmp file would silently widen that to 644.
function writeSettings(json) {
  let target = SETTINGS_PATH;
  let mode = 0o600;
  try {
    target = fs.realpathSync(SETTINGS_PATH);
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    /* not there yet: create it at the plain path with 600 */
  }
  const tmp = target + '.claude-radar.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode); // mode above only applies on create, not to a leftover tmp file
  fs.renameSync(tmp, target);
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
    const groups = stripOwnHooks(json.hooks[spec.event]);
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
  writeSettings(json);
  // Claude Code reads hooks only when a session starts: one that is already
  // running keeps writing no markers until it's restarted.
  vscode.window.showInformationMessage(
    (auto ? 'Hooks updated' : 'Hooks installed') +
      '. Backup saved. Claude loads hooks at session start, so restart any session that is already running.'
  );
}

// Uninstall path: a "vscode:uninstall" script in the manifest could do this
// automatically, but rewriting ~/.claude/settings.json unasked is exactly
// what this extension avoids everywhere else, so removal stays an explicit
// command. Only our own (tab-status) hooks; others stay.
async function removeHooks() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    // An unreadable file is not an absent one: "nothing to remove" would
    // claim the hooks are gone while they are still installed.
    if (fs.existsSync(SETTINGS_PATH)) {
      vscode.window.showErrorMessage(
        "~/.claude/settings.json isn't valid JSON, so no hooks were removed: " + e.message
      );
    } else {
      vscode.window.showInformationMessage('No Claude settings found, nothing to remove.');
    }
    return;
  }
  const before = JSON.stringify(json.hooks || {});
  for (const event of Object.keys(json.hooks || {})) {
    json.hooks[event] = stripOwnHooks(json.hooks[event]);
    if (json.hooks[event].length === 0) delete json.hooks[event];
  }
  if (JSON.stringify(json.hooks || {}) === before) {
    vscode.window.showInformationMessage('No Radar for Claude Code hooks to remove.');
    return;
  }
  fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.claude-radar.bak');
  writeSettings(json);
  vscode.window.showInformationMessage('Radar for Claude Code hooks removed. Backup saved.');
}

// Setup is required: without the title variable and the hooks, no marker can
// ever appear. Re-offer on activation until it's done, with a permanent
// opt-out. The hourly rate limit keeps the offer from returning at every
// window you open; it does not help on a cold start, where all windows read
// the same unset timestamp and each shows the dialog. That costs N
// idempotent info toasts once, which beats a lock file.
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
  detectBundleId();

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

  // Drop the marker and everything derived from it. Used by the Clear command
  // and by the sweep below, which reaches the same conclusion on its own.
  const clearState = () => {
    currentLabel = null;
    workingSince = null;
    agentCount = 0;
    lastToolFailed = false;
    sawInterrupt = false;
    return setMarker(null);
  };

  // One read-only pass while a marker is on display: is anyone still working
  // in this project, and did the transcript record an Esc interrupt? Both end
  // the same way, with a marker that was lying removed. Returns true when it
  // cleared, so the caller can stop.
  const sweep = () => {
    const root = projectRoot();
    if (!root) return false;
    const sessions = liveSessionsHere(root);
    if (sessions === undefined) return false; // can't tell: leave it alone
    if (sessions.length === 0) {
      clearState();
      return true;
    }
    scanTranscripts(sessions);
    if (sawInterrupt) {
      clearState(); // resets sawInterrupt
      return true;
    }
    return false;
  };

  // Refresh the elapsed time once a minute while 'working' is shown; a no-op
  // with the setting off (setMarker then rebuilds the same string).
  const timeTick = setInterval(() => {
    if (currentLabel === 'working' && workingSince) setMarker('working');
  }, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(timeTick) });

  // The only recurring scan, and it runs solely while a marker is on display:
  // with an empty title (the normal state) this returns immediately, so an
  // idle window still costs nothing. The sweep goes first - once the marker is
  // gone there is no agent count left to refresh.
  const watchTick = setInterval(() => {
    if (!currentLabel) return;
    if (sweep()) return;
    if (currentLabel === 'working' && updateAgentCount()) setMarker('working');
  }, AGENT_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(watchTick) });

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
      // The Stop hook can't know whether the turn ended on a failed tool call,
      // so the transcript decides between done and failed. Scanning here and
      // not just on the tick matters: Stop lands milliseconds after the last
      // tool result, long before the next tick would have seen it.
      if (label === 'stop') {
        const root = projectRoot();
        const sessions = root ? liveSessionsHere(root) : undefined;
        if (sessions && sessions.length > 0) scanTranscripts(sessions);
        if (lastToolFailed) label = 'error';
      }
      // How long the run took, read before the state below clears it: the
      // done banner reports it, which is the first thing you want to know
      // when one pops up after you've been away. Empty below a minute.
      const ranFor = (label === 'stop' || label === 'error') && workingSince ? elapsedLabel(workingSince) : '';
      // The elapsed time counts from your last prompt: 'prompt' (re)starts
      // the clock unconditionally, the frequent PostToolUse 'working'
      // repeats only start it when it isn't running, and every other event
      // stops it. Unconditional here is what fixes an interrupted turn:
      // Esc fires no hook, so the clock keeps running until the next prompt
      // - which is exactly this branch.
      if (label === 'prompt') {
        workingSince = Date.now();
        label = 'working';
        // A new prompt starts a clean turn: whatever failed in the previous
        // one must not colour this one's ending red.
        lastToolFailed = false;
        sawInterrupt = false;
      } else if (label === 'working') {
        if (!workingSince) workingSince = Date.now();
      } else {
        workingSince = null;
      }
      const wasWorking = currentLabel === 'working';
      currentLabel = label;
      clearTimeout(peekTimer); // a running peek must never overwrite a new event
      // 'working' is a lasting state and always visible (even in the active
      // window), never with banner/sound -> no flicker on focus changes
      // while Claude is working.
      if (label === 'working') {
        // Entering 'working' counts agents right away instead of waiting up
        // to a poll tick; the frequent PostToolUse repeats don't re-scan,
        // check() has to stay cheap.
        if (!wasWorking) updateAgentCount();
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
      notify(label, ranFor);
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
      // Toggling the time display or the agent symbol shows up right away,
      // not on the next tick
      if (
        (e.affectsConfiguration('claudeRadar.showWorkingTime') ||
          e.affectsConfiguration('claudeRadar.markerAgents')) &&
        currentLabel === 'working'
      )
        setMarker('working');
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
    vscode.commands.registerCommand('claudeRadar.clear', () => {
      // Drop the state too, not just the marker, or the next tick or focus
      // change would put 💬 right back. Since the sweep clears an interrupted
      // or dead session by itself, this is now the manual override rather than
      // the only way out.
      return clearState();
    }),
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
