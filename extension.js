// Radar for Claude Code
//
// How it works:
// 1. Registers the window-title variable ${claudeRadarStatus} (VS Code >= 1.93,
//    "registerWindowTitleVariable" command); its value comes from a context
//    key. In-memory only, no per-window settings writes.
// 2. Claude Code hooks write a marker file per event to
//    ~/.claude/tab-status/<sha256(project path)[0..16]>, content = event
//    label (working | waiting | stop | error), for 'error' followed by the
//    reason on a second line.
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
// 'prompt' is 'working' with a reset clock (see check()), not a state of its
// own; 'error' comes from StopFailure (see check() for both).
const LABELS = ['prompt', 'working', 'waiting', 'stop', 'error'];
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
//
// The 'working' it writes then carries 'background' on a second line: the
// session really is idle while it waits for the task to wake it, and its
// registry entry says so (see registryVerdict), so the extension must know
// that this 'working' is held on purpose and not mistake the idle for a turn
// that ended without a Stop. An extension older than the hook ignores the
// line, check() only reads the first one for the label.
//
// The line says 'shell' instead when nothing but shell tasks is left (only
// possible with the setting on). Radar cannot tell a build that is about to
// finish from a server that never will, and a 💬 counting minutes over a
// server claims work nobody is doing. So that hold gets a marker of its own,
// without a clock (see setMarker). Verified live against Claude Code 2.1.296:
// a background command shows up as type 'shell', status 'running', and the
// session itself goes idle while it runs.
const HELD_JQ = `[(.background_tasks // [])[]? | select((.status // .state) as $s | $s=="running" or $s=="in_progress" or $s=="pending")] | if any(.[]; .type != "shell") then "background" elif $a=="1" and length>0 then "shell" else "" end`;
const HELD_PY = `import sys,json,os;d=json.load(sys.stdin);ts=[t for t in (d.get("background_tasks") or []) if (t.get("status") or t.get("state")) in ("running","in_progress","pending")];print("background" if any(t.get("type")!="shell" for t in ts) else "shell" if ts and os.environ.get("A")=="1" else "")`;
const stopMarker =
  `${MARKER_F}; in="$(cat)"; h=""; a=0; [ -f "$d/.shell-keeps-working" ] && a=1; ` +
  `if command -v jq >/dev/null 2>&1; then h="$(printf '%s' "$in" | jq -r --arg a "$a" '${HELD_JQ}' 2>/dev/null)"; ` +
  `elif command -v python3 >/dev/null 2>&1; then h="$(printf '%s' "$in" | A="$a" python3 -c '${HELD_PY}' 2>/dev/null)"; fi; ` +
  `case "$h" in background|shell) printf 'working\\n%s' "$h";; *) printf stop;; esac ${WRITE_F}`;

// The turn died on Claude's side: a spend limit, a 529, an expired session, a
// connection lost mid-response. Claude Code ends it with StopFailure instead
// of Stop, and last_assistant_message carries the text it shows in the
// terminal. Label 'error', the message on a second line, so the banner can say
// why (see shortReason()). Without jq or python3 the label goes out alone.
const REASON_JQ = `.last_assistant_message // .error_details // .error // ""`;
const REASON_PY = `import sys,json;d=json.load(sys.stdin);print(d.get("last_assistant_message") or d.get("error_details") or d.get("error") or "")`;
const stopFailureMarker =
  `${MARKER_F}; in="$(cat)"; r=""; ` +
  `if command -v jq >/dev/null 2>&1; then r="$(printf '%s' "$in" | jq -r '${REASON_JQ}' 2>/dev/null)"; ` +
  `elif command -v python3 >/dev/null 2>&1; then r="$(printf '%s' "$in" | python3 -c '${REASON_PY}' 2>/dev/null)"; fi; ` +
  `printf 'error\\n%s' "$r" ${WRITE_F}`;

// Background work that finishes wakes the session with a prompt of its own,
// and that fires UserPromptSubmit like a typed one. The hook tells them apart
// by the opening of .prompt and adds 'wake' on a second line, so the clock of
// the run they belong to keeps going (see check()). Measured against Claude
// Code 2.1.299: an ended command sends <task-notification>, an agent's
// hand-back <agent-message from="...">. The transcript shows the hand-back
// behind "Another Claude session sent a message:", the hook got it without;
// both count. An extension older than the hook reads a plain 'prompt'.
const WAKE_PREFIXES = ['<task-notification>', '<agent-message ', 'Another Claude session sent a message:'];
const WAKE_JQ = `(.prompt // "") as $p | if any(${JSON.stringify(WAKE_PREFIXES)}[]; . as $w | $p | startswith($w)) then "wake" else "" end`;
const WAKE_PY = `import sys,json;p=json.load(sys.stdin).get("prompt") or "";print("wake" if p.startswith(tuple(${JSON.stringify(WAKE_PREFIXES)})) else "")`;
const promptMarker =
  `${MARKER_F}; w=""; ` +
  `if command -v jq >/dev/null 2>&1; then w="$(jq -r '${WAKE_JQ}' 2>/dev/null)"; ` +
  `elif command -v python3 >/dev/null 2>&1; then w="$(python3 -c '${WAKE_PY}' 2>/dev/null)"; fi; ` +
  `case "$w" in wake) printf 'prompt\\nwake';; *) printf prompt;; esac ${WRITE_F}`;

const HOOK_SPECS = [
  // A new prompt shows 'working' like every other event, but with a fresh
  // clock: its own label separates "you just sent something" from the
  // PostToolUse 'working' repeats, which must not reset the time (see
  // check()). Without it the elapsed time kept running across an interrupted
  // turn - Esc fires no hook at all (verified against Claude Code 2.1.209:
  // no Stop, no Notification, nothing), so the old 'working' from the
  // aborted turn survived into the next one and the title showed minutes
  // that had never been worked. A wake-up from background work says so and
  // keeps the clock (see promptMarker).
  { event: 'UserPromptSubmit', matcher: '', command: promptMarker }, // working, clock restarted unless woken (no banner/sound)
  // Notification fires for more than "needs you": the matcher filters on
  // .notification_type, so list the types that actually wait for the user.
  // Without it, auth_success, elicitation_complete/-response and
  // agent_completed each raised ⚠️ with a Basso - a false alarm for
  // something that had just finished on its own.
  {
    event: 'Notification',
    matcher: 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input',
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
  // async: Claude Code would otherwise wait ~30 ms for the shell after every
  // tool call, hundreds of times in a long turn. Ordering stays safe without
  // the wait: the next event that could contradict 'working' (Stop, a
  // question, a permission) only arrives after another model response,
  // seconds later.
  { event: 'PostToolUse', matcher: '', command: writeMarker('working'), async: true },
  // A failed tool call gets this event instead of PostToolUse; Claude reads
  // the error and carries on, so it is 'working' all the same. Without it, a
  // permission prompt followed by a failing call left ⚠️ standing until the
  // next successful call. The payload's is_interrupt (Esc while the tool ran)
  // is of no use here: Claude Code runs these hooks under the turn's abort
  // signal, so on Esc the hook is cancelled before it can write anything
  // (verified live against 2.1.258). The sweep catches that case from the
  // transcript instead.
  { event: 'PostToolUseFailure', matcher: '', command: writeMarker('working') },
  { event: 'Stop', matcher: '', command: stopMarker }, // done - unless background work is still running
  { event: 'StopFailure', matcher: '', command: stopFailureMarker }, // the turn died on Claude's side
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

// A folder's path the way Claude Code spells it: symlinks resolved, in the
// case the disk stores, composed (NFC). That one spelling is what its hooks
// hash, what its session registry reports and what its transcript folders
// are named after, whatever was typed to get there (measured against 2.1.322
// by starting it in a folder under another case, and in one whose umlaut the
// disk keeps as letter plus accent). VS Code reports the path as it was typed
// or picked, and Node's own realpathSync keeps that spelling, so a window
// opened as ~/Dev/app never met the marker of ~/dev/app. The native one asks
// the disk. Unresolvable (just deleted) falls back to the path as given.
function claudeSpelling(p) {
  try {
    return fs.realpathSync.native(p).normalize('NFC');
  } catch {
    return p;
  }
}

// The first workspace folder. Everything project-scoped keys off this: the
// marker file, the transcript folder, and the cwd match against running
// sessions. A folder that is gone keeps the path VS Code reports, so its
// marker still has a stable name.
function projectRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return claudeSpelling(folders[0].uri.fsPath);
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
// True while 'working' is held for nothing but a background shell command
// (the Stop hook says so). Shown with a marker of its own and no clock.
let shellHold = false;

// Live count of running subagents (💬 14m 🤖8). Claude Code keeps one
// transcript per subagent under ~/.claude/projects/<slug>/<session>/subagents/
// (workflow agents one level deeper, in workflows/<runId>/). The transcript
// says whether its agent is done: a finished one ends on the final answer (an
// assistant line with stop_reason end_turn) or, for workflow agents, on the
// StructuredOutput result (a user line flagged toolEndsTurn). Anything else
// (a tool_use waiting for its result, a result waiting for the model) is an
// agent mid-work. Measured over 77 finished transcripts: 73 end on
// toolEndsTurn, 4 on end_turn, none on anything else, and toolEndsTurn never
// shows up before the last line. A stopped agent is done as well, and its
// transcript closes on the interrupt line: taken down by Esc together with
// its turn, mid-tool or mid-answer, or stopped on its own from the panel
// (verified live against Claude Code 2.1.296 on five agents stopped in
// these ways). Bookkeeping can follow the last word: attachment lines such
// as a snapshot of the whole system prompt (2 to 111 KB, half of them
// longer than the first tail read). Measured over 991 transcripts: 12
// finished agents end that way, 3 from 2.1.278, 9 from 2.1.299 on.
// Attachment lines say nothing about progress and are stepped over.
// Read-only polling instead of SubagentStop:
// a hook event can be missed (Esc, kill) and would leave the count stuck.
// The mtime window is only the fallback for exactly those agents: killed with
// their session, they leave a mid-work transcript behind that would count
// forever. It used to be the whole mechanism, and tight (2 min), which made
// the count dip whenever an agent thought or built for longer: 38 to 61 % of
// Opus 5 / Fable 5 agents sit silent for over two minutes at least once.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const AGENT_STALE_MS = 10 * 60000;
const AGENT_TAIL_BYTES = 64 * 1024;
const AGENT_TAIL_MAX_BYTES = 512 * 1024;
const AGENT_POLL_MS = 10000;
let agentCount = 0;

function agentTranscriptRoot() {
  const p = projectRoot();
  return p ? path.join(PROJECTS_DIR, slugFor(p)) : undefined;
}

// The content block Claude Code writes when a run is stopped, in a session's
// transcript and in a subagent's alike. Checking the structure matters: the
// same words show up inside tool output whenever anyone greps for them, so a
// plain substring scan would fire on that. Verified against the real
// transcripts: the interrupt is always its own text block on a user line.
const isInterruptBlock = (b) =>
  !!b && b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted by user');

// Does the transcript's last word say the agent is done? Reads only the tail,
// and a wider one when the first ends inside a line. Undecidable cases (a line
// longer than the wider tail, not JSON, an empty file) answer false: the agent
// then stays in the count until the mtime fallback lets it go.
function agentFinished(file, size) {
  if (size === 0) return false;
  const verdict = tailVerdict(file, size, Math.min(size, AGENT_TAIL_BYTES));
  if (verdict !== undefined || size <= AGENT_TAIL_BYTES) return verdict === true;
  return tailVerdict(file, size, Math.min(size, AGENT_TAIL_MAX_BYTES)) === true;
}

// The last complete line that is not an attachment, read from the last len
// bytes: true or false once decided, undefined when that line began before
// the tail.
function tailVerdict(file, size, len) {
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  // Claude may be mid-write, so a tail without its newline is skipped, and so
  // are blank lines.
  let end = buf.lastIndexOf(0x0a);
  for (;;) {
    while (end > 0 && buf[end - 1] === 0x0a) end--;
    if (end <= 0) return len < size ? undefined : false;
    const start = buf.lastIndexOf(0x0a, end - 1) + 1;
    if (start === 0 && len < size) return undefined;
    let d;
    try {
      d = JSON.parse(buf.subarray(start, end).toString('utf8'));
    } catch {
      return false;
    }
    if (!d || typeof d !== 'object') return false;
    if (d.type === 'attachment') {
      end = start - 1;
      continue;
    }
    if (d.type === 'user') {
      if (d.toolEndsTurn === true) return true;
      const content = d.message && d.message.content;
      return Array.isArray(content) && content.some(isInterruptBlock);
    }
    return d.type === 'assistant' && !!d.message && d.message.stop_reason === 'end_turn';
  }
}

function countActiveAgents() {
  const root = agentTranscriptRoot();
  if (!root) return 0;
  const cutoff = Date.now() - AGENT_STALE_MS;
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
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          if (st.mtimeMs < cutoff) continue; // silent for ten minutes: gone, whatever it says
          if (!agentFinished(file, st.size)) n++;
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

// Live sessions and their transcripts. Three things Radar cannot learn from
// hooks come from here, all read-only and all only while a marker shows:
//
// 1. Liveness. A hook fires only while Claude runs. Dies the process mid-turn
//    (crash, closed terminal, window reload), no Stop ever arrives and the
//    marker hangs forever, running clock included. A pid that no longer
//    answers proves nobody is working in this project.
// 2. The transcript. sessionId names the JSONL under PROJECTS_DIR, which
//    records two events no hook reports: the Esc interrupt (Claude Code fires
//    nothing usable for it, see the PostToolUseFailure note above) and a
//    failed tool call.
// 3. The session's own state (registryVerdict below): since Claude Code
//    2.1.269 the registry entry says whether its session is busy, idle or
//    waiting for you. Written from the CLI's state machine, not from hooks.

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
    // wrongly counted as gone takes a live marker with it. A directory that
    // is gone compares as the session reported it.
    const cwd = claudeSpelling(d.cwd);
    // Prefix, not equality: Claude may have been started in a subfolder while
    // the marker hangs on the project root (the hook uses CLAUDE_PROJECT_DIR).
    // Deliberately no filter on d.entrypoint, or sessions started in a plain
    // terminal would count as dead and lose their marker.
    if (cwd === root || cwd.startsWith(root + path.sep)) here.push(d);
  }
  return sawAny ? here : undefined;
}

// What the sessions say about the turn themselves. The registry entry carries
// status 'busy' | 'idle' | 'waiting' (| 'shell'), waitingFor naming the
// prompt ('permission prompt', 'input needed'), and statusUpdatedAt stamping
// the change (read off Claude Code 2.1.273: the CLI maps its own
// running/requires_action/idle onto these, and only writes on a change). So
// it also records what no hook reports: Esc during a tool call, a hook that
// never ran, a dialog outside the Notification matcher. `since` is when the
// marker started: an older entry belongs to an earlier turn, or to a session
// that has been idle all along, and proves nothing about this one - which is
// also what keeps the race at turn start harmless, when the prompt hook has
// fired but the CLI has not yet written 'busy'.
// Returns { label: 'idle' } when every session of the project is idle and at
// least one became so during this turn, { label: 'waiting', reason } when one
// asks for input since then, undefined otherwise. undefined covers "can not
// tell" (an older Claude Code without the field) as well as "someone is still
// busy", and the caller must leave the marker alone either way.
function registryVerdict(sessions, since) {
  let idleAt = 0;
  let reason;
  for (const s of sessions) {
    if (typeof s.status !== 'string') continue; // older Claude Code: no field
    const at = typeof s.statusUpdatedAt === 'number' ? s.statusUpdatedAt : 0;
    if (s.status === 'idle') {
      idleAt = Math.max(idleAt, at);
    } else if (s.status === 'waiting' && at >= since) {
      reason = typeof s.waitingFor === 'string' ? s.waitingFor : '';
    } else {
      // busy, shell, a waiting from before this turn (another session's
      // prompt, whose own hook has had its say), or a value this code does
      // not know: someone may well be working, so no verdict.
      return undefined;
    }
  }
  if (reason !== undefined) return { label: 'waiting', reason };
  if (idleAt >= since) return { label: 'idle' };
  return undefined;
}

// The opposite question, asked against a ⚠️: has its prompt been answered?
// No hook fires when you allow a permission; the next one comes when the tool
// call that waited for it has finished. A ⚠️ answered from somewhere else (a
// phone, a terminal: this window never got the focus that would have
// acknowledged it) therefore stood through the whole command, long after
// anyone was waiting. The registry does record the moment: the session
// goes from waiting back to busy and stamps it (verified live against Claude
// Code 2.1.296, answered after 3 s and after 25 s). `since` is when the ⚠️
// showed. True when no session of the project is waiting any more and one
// went to work after that. A session still waiting keeps the ⚠️ whoever else
// is busy: with two sessions in a project, the working one must not take the
// other's prompt off the title. Busy from before the ⚠️ proves nothing
// either, that is a second session working all along.
function workResumed(sessions, since) {
  let resumed = false;
  for (const s of sessions) {
    if (s.status === 'waiting') return false;
    if (s.status === 'busy' && typeof s.statusUpdatedAt === 'number' && s.statusUpdatedAt >= since) resumed = true;
  }
  return resumed;
}

// Bytes already read per transcript. A file seen for the first time is
// measured, and nothing but what the running turn wrote is read from it (see
// scanTranscripts): its history holds interrupts and errors from earlier
// turns that must not fire now.
const tailOffsets = new Map();
// A transcript can be new to the window because its session is: Claude Code
// writes the file a moment after the first prompt (median 146 ms over 472
// sessions), so the window first meets it at the next tick, or at the Stop
// of a turn shorter than that. Only while the prompt is that recent is a
// first sight read at all. Later it is some other session showing up, and
// what it wrote lately is not the end of the turn on display.
const FIRST_SIGHT_MS = 2 * AGENT_POLL_MS;
// How much of it is read then: the turn began seconds ago, its lines are the
// last ones in the file.
const FIRST_READ_BYTES = 256 * 1024;
// The window notes a prompt a moment after the hook has fired, so the lines
// of its turn may be stamped slightly before that.
const TURN_MARGIN_MS = 5000;
// Set when the transcript shows the turn was interrupted with Esc.
let sawInterrupt = false;
// The turn's closing words. A turn that ends by asking something needs you
// just as much as a permission prompt does, but Claude Code reports it as a
// plain Stop - so the marker used to say "done" and the question sat there
// unanswered. Measured over 7528 real turn endings, 3 % close with a question.
let lastAssistantText = '';
// Squeeze the message of a turn that died on Claude's side (from the
// StopFailure payload) into a banner subtitle. Deliberately generic: the
// wordings change between Claude Code releases, so this cuts at the first
// sentence boundary instead of matching texts we happen to know today.
function shortReason(text) {
  const s = text.replace(/^API Error:\s*/, '').split(/[.·\n]/)[0].trim();
  if (s === '') return 'API error';
  return s.length > 48 ? s.slice(0, 48).trimEnd() + '…' : s;
}
// True while the most recent tool call failed. Measured over 1464 real turns:
// "the last tool_result was an error" marks 2 %, while "any error somewhere in
// the turn" marks 6 % - mostly failures Claude recovered from in the same
// turn, which is exactly what Radar must not report.
let lastToolFailed = false;

function scanTranscriptLine(line, notBefore = 0) {
  // Cheap pre-filter. tool_result also has to pass when it succeeded, that is
  // what resets lastToolFailed.
  if (
    !line.includes('tool_result') &&
    !line.includes('Request interrupted') &&
    !line.includes('"assistant"')
  ) {
    return;
  }
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  // From a transcript met for the first time, a line counts only when its
  // stamp says the running turn wrote it. Anything else is history: a resumed
  // or forked session opens with the earlier conversation. A line without a
  // stamp cannot be told from it.
  if (notBefore && !(Date.parse(d.timestamp) >= notBefore)) return;
  const content = d.message && d.message.content;
  if (!Array.isArray(content)) return; // a typed prompt is a plain string

  if (d.type === 'assistant') {
    // Claude Code flags its own error messages; they are not Claude's closing
    // words. (The StopFailure hook reports them, not the transcript.)
    if (d.isApiErrorMessage === true) return;
    // Claude splits one message across several lines, one per content block,
    // so the last text block seen is the turn's closing text.
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
        lastAssistantText = b.text;
      }
    }
    return;
  }
  if (d.type !== 'user') return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (isInterruptBlock(b)) sawInterrupt = true;
    if (b.type === 'tool_result') lastToolFailed = b.is_error === true;
  }
}

// Read what is new in this project's transcripts and fold it into the flags
// above. Only whole lines are consumed: Claude may be mid-write, and
// advancing past a partial line would drop it for good. turnStart is when the
// last prompt arrived, 0 when this window has seen none.
function scanTranscripts(sessions, turnStart = 0) {
  const young = turnStart > 0 && Date.now() - turnStart < FIRST_SIGHT_MS;
  for (const s of sessions) {
    const file = path.join(PROJECTS_DIR, slugFor(s.cwd), s.sessionId + '.jsonl');
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue; // no transcript yet
    }
    let seen = tailOffsets.get(file);
    const first = seen === undefined || size < seen; // first sight, or replaced
    if (first) {
      if (!young) {
        tailOffsets.set(file, size); // baseline only
        continue;
      }
      seen = Math.max(0, size - FIRST_READ_BYTES);
    }
    if (size === seen) {
      tailOffsets.set(file, size);
      continue;
    }
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
    const lines = buf.subarray(0, nl).toString('utf8').split('\n');
    // A first read that does not reach back to the first byte begins inside
    // a line.
    if (first && seen > 0) lines.shift();
    const notBefore = first ? turnStart - TURN_MARGIN_MS : 0;
    for (const line of lines) {
      if (line) scanTranscriptLine(line, notBefore);
    }
  }
}

// Does the turn close on a question? The last non-empty line decides: Claude
// often explains at length and then asks in the final line, and anything
// looser (a '?' anywhere) would fire on rhetorical questions mid-text.
function endsWithQuestion(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l !== '') return l.endsWith('?');
  }
  return false;
}

// '' below one minute, then '14m', from an hour on '1h05'.
function elapsedLabel(since) {
  const m = Math.floor((Date.now() - since) / 60000);
  if (m < 1) return '';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
}

// label: 'working' | 'waiting' | 'stop' | 'error' sets the matching marker,
// null removes it. 'error' comes from the StopFailure hook, or check() derives
// it from the transcript when a turn ended on a failed tool call.
function setMarker(label) {
  let marker = '';
  if (label) {
    const cfg = vscode.workspace.getConfiguration('claudeRadar');
    const held = label === 'working' && shellHold;
    const symbol = (
      label === 'waiting' ? cfg.get('markerWaiting', '⚠️')
      : held ? cfg.get('markerShellTask', '⏳')
      : label === 'working' ? cfg.get('markerWorking', '💬')
      : label === 'error' ? cfg.get('markerError', '🔴')
      : cfg.get('markerDone', '🟢')
    ).trim();
    let time = '';
    if (label === 'working' && !held && workingSince && cfg.get('showWorkingTime', true)) {
      const t = elapsedLabel(workingSince);
      if (t) time = ' ' + t;
    }
    let agents = '';
    if (label === 'working' && !held && agentCount > 0) {
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
function notify(label, ranFor = '', ranMs = 0, reason = '') {
  const cfg = vscode.workspace.getConfiguration('claudeRadar');
  if (!cfg.get('banner', true)) return;
  if (isMuted()) return;
  // Short turns can ping more than they help. Only the done banner is gated:
  // a question, a permission, or a failure wants you no matter how fast it
  // arrived. ranMs of 0 means the run time is unknown, so nothing is skipped.
  const minDone = Number(cfg.get('minDoneSeconds', 0)) * 1000;
  if (label === 'stop' && minDone > 0 && ranMs > 0 && ranMs < minDone) return;
  detectBinaries(); // lazy: also picks up a terminal-notifier installed after startup

  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const projectName = folder ? folder.name : 'VS Code';
  const projectPath = folder ? folder.uri.fsPath : '';
  const failed = label === 'error';
  const done = label === 'stop';
  const subtitle = failed
    ? reason !== '' ? reason : ranFor ? 'Failed after ' + ranFor : 'Failed'
    : done
      ? ranFor ? 'Done after ' + ranFor : 'Done'
      : reason !== '' ? 'Needs you: ' + reason : 'Needs you';
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
    // The async flag is part of the key too: 1.2.0 made PostToolUse async with
    // an unchanged command, and a key without it would never reconcile that.
    const keyOf = (matcher, h) =>
      String(matcher || '') + '\u0000' + String(h.command || '') + '\u0000' + (h.async === true ? 'async' : '');
    const expected = byEvent(HOOK_SPECS.map((s) => [s.event, keyOf(s.matcher, s)]));
    const installed = byEvent(
      Object.entries(json.hooks || {}).flatMap(([event, groups]) =>
        (groups || []).flatMap((g) =>
          (g.hooks || [])
            .filter((h) => String(h.command || '').includes('tab-status'))
            .map((h) => [event, keyOf(g.matcher, h)])
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
  // One temp file per window. After an update every window reconciles the
  // hooks as it starts, and with a shared name one renamed the file away
  // under the next, or published it while that one had just emptied it.
  const tmp = `${target}.claude-radar.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n', { mode });
  fs.chmodSync(tmp, mode); // mode above only applies on create, not to a leftover tmp file
  fs.renameSync(tmp, target);
}

// The backup goes through a temp file of its own as well: two windows copying
// into the same file at once left a mix of both behind.
function backupSettings() {
  const bak = SETTINGS_PATH + '.claude-radar.bak';
  const tmp = `${bak}.tmp.${process.pid}`;
  fs.copyFileSync(SETTINGS_PATH, tmp);
  fs.renameSync(tmp, bak);
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
    const hook = { type: 'command', command: spec.command };
    if (spec.async) hook.async = true;
    groups.push({ matcher: spec.matcher, hooks: [hook] });
    json.hooks[spec.event] = groups;
  }
  if (JSON.stringify(json.hooks) === before) {
    // Stay quiet during the automatic reconcile; only the manually invoked
    // command reports back when there's nothing to do.
    if (!auto) vscode.window.showInformationMessage('Hooks are already up to date.');
    return;
  }
  if (existed) backupSettings();
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
  backupSettings();
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
  // True while the Stop hook holds 'working' for background work (a
  // workflow, a background agent, a shell task with the setting on). The
  // session itself is idle then, waiting for the task to wake it, so the
  // registry's idle must not end the turn. Any other event settles it.
  let backgroundWork = false;
  // When the ⚠️ on display first showed (see showAttention).
  let waitingSince = 0;
  // When the last prompt arrived, typed or sent by background work that
  // ended. The clock can be older than that: a wake-up keeps it (see check()).
  let promptAt = 0;
  let peekTimer; // hides the briefly shown marker in the active window again
  context.subscriptions.push({ dispose: () => clearTimeout(peekTimer) });

  // Drop the marker and everything derived from it. Used by the Clear command
  // and by the sweep below, which reaches the same conclusion on its own.
  const clearState = () => {
    currentLabel = null;
    workingSince = null;
    backgroundWork = false;
    shellHold = false;
    agentCount = 0;
    lastToolFailed = false;
    sawInterrupt = false;
    lastAssistantText = '';
    return setMarker(null);
  };

  // waiting/stop/error are attention events. In the focused window, "peek":
  // show the marker ~1 s, then hide it, without banner/sound. The user sees it
  // once, then the tab is quiet again. Unfocused: persistent marker + banner.
  const showAttention = (label, ranFor = '', ranMs = 0, reason = '') => {
    clearTimeout(peekTimer); // a running peek must never outlive a new event
    // When this ⚠️ first showed: the sweep measures an answered prompt against
    // it. A repeat keeps the time, a permission prompt alone arrives as two
    // hook events.
    if (label === 'waiting' && currentLabel !== 'waiting') waitingSince = Date.now();
    currentLabel = label;
    if (vscode.window.state.focused) {
      currentLabel = null; // counts as seen
      setMarker(label);
      peekTimer = setTimeout(() => {
        if (vscode.window.state.focused) setMarker(null);
      }, PEEK_MS);
      return;
    }
    setMarker(label);
    notify(label, ranFor, ranMs, reason);
  };

  // One read-only pass while a marker is on display: is anyone still working
  // in this project, did the transcript record an Esc interrupt, and what do
  // the sessions say about themselves? A marker that was lying is removed or
  // corrected. Returns true when it changed the state, so the caller can
  // stop.
  const sweep = () => {
    const root = projectRoot();
    if (!root) return false;
    const sessions = liveSessionsHere(root);
    if (sessions === undefined) return false; // can't tell: leave it alone
    if (sessions.length === 0) {
      clearState();
      return true;
    }
    scanTranscripts(sessions, promptAt);
    if (sawInterrupt) {
      sawInterrupt = false;
      // Esc ends the turn, not necessarily the work. Since Claude Code 2.1.286
      // the VS Code panel leaves background agents running on Stop and Esc
      // (verified live against 2.1.296: the agent worked on for 43 s after
      // the interrupt, and no hook fired in all that time). They are what the
      // marker stands for then, so it stays while one is still at it. An
      // agent that went down with the turn closes its transcript on the
      // interrupt line and does not count (see agentFinished). Nothing extra
      // is needed to end this: an agent that finishes or gets stopped wakes
      // the session with a prompt of its own, and that turn's hooks take over.
      if (currentLabel !== 'working' || countActiveAgents() === 0) {
        clearState();
        return true;
      }
    }
    // A ⚠️ whose prompt has been answered goes back to 💬: Claude is working
    // again, and no hook will say so before the tool call ends. The clock
    // starts over, as it does when a hook reports the next tool call.
    if (currentLabel === 'waiting' && workResumed(sessions, waitingSince)) {
      currentLabel = 'working';
      shellHold = false;
      workingSince = Date.now();
      updateAgentCount();
      setMarker('working');
      return true;
    }
    // The registry's verdict only matters against a 'working' marker: the
    // attention labels came from a hook that knew better, or have already
    // been seen. A turn that ended without a Stop is cleared like the Esc
    // above, deliberately without a done banner - nobody said how it ended.
    // Not while the marker is held for background work: idle is the expected
    // state then. A prompt the hooks missed gets the same "needs you" a hook
    // would raise, plus the reason the registry names.
    // Measured from the last prompt where that is later than the clock: a
    // wake-up keeps the clock of its run, and the idle the session sat in
    // while the marker was held is newer than that clock. Until the CLI had
    // written busy again, it read as the end of the turn that had just begun.
    if (currentLabel === 'working' && workingSince) {
      const verdict = registryVerdict(sessions, Math.max(workingSince, promptAt));
      if (verdict && verdict.label === 'idle' && !backgroundWork) {
        clearState();
        return true;
      }
      if (verdict && verdict.label === 'waiting') {
        workingSince = null;
        showAttention('waiting', '', 0, verdict.reason);
        return true;
      }
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
      // First line is the label; StopFailure adds its reason on a second line.
      let label = '';
      let reason = '';
      try {
        const raw = fs.readFileSync(claim, 'utf8');
        const nl = raw.indexOf('\n');
        label = (nl === -1 ? raw : raw.slice(0, nl)).trim();
        if (nl !== -1) reason = raw.slice(nl + 1).trim();
      } finally {
        try {
          fs.unlinkSync(claim);
        } catch {
          /* already gone, fine */
        }
      }
      if (!LABELS.includes(label)) label = 'stop'; // unexpected content -> treat as done
      // Only the StopFailure hook brings a reason. A failed last tool call
      // (below) has none; its banner just says "Failed". The Stop hook's
      // 'working' says 'background' there when it holds the marker for
      // background work; the per-tool-call repeats say nothing, a prompt says
      // 'wake' when background work sent it, and either one means the session
      // is awake again.
      const why = label === 'error' ? shortReason(reason) : '';
      // A wake-up belongs to the run that started the background work, so a
      // 💬 held for that work keeps its clock. After ⏳ the clock starts over:
      // the hold showed no time, and a command running is not Claude working.
      const wake = label === 'prompt' && reason === 'wake' && currentLabel === 'working' && !shellHold && !!workingSince;
      // 'shell' is the same hold with nothing but a background command left.
      shellHold = label === 'working' && reason === 'shell';
      const heldForBackground = shellHold || (label === 'working' && reason === 'background');
      // The Stop hook can't know whether the turn ended on a failed tool call,
      // so the transcript decides between done and failed. Scanning here and
      // not just on the tick matters: Stop lands milliseconds after the last
      // tool result, long before the next tick would have seen it.
      if (label === 'stop') {
        const root = projectRoot();
        const sessions = root ? liveSessionsHere(root) : undefined;
        if (sessions && sessions.length > 0) scanTranscripts(sessions, promptAt);
        // A question wins over a failure: both send you to the window, but
        // "answer me" is the more accurate instruction than "look at this".
        if (
          vscode.workspace.getConfiguration('claudeRadar').get('detectQuestions', true) &&
          endsWithQuestion(lastAssistantText)
        ) {
          label = 'waiting';
        } else if (lastToolFailed) {
          label = 'error';
        }
      }
      // How long the run took, read before the state below clears it: the
      // done banner reports it, which is the first thing you want to know
      // when one pops up after you've been away. Empty below a minute.
      const ranFor = (label === 'stop' || label === 'error') && workingSince ? elapsedLabel(workingSince) : '';
      const ranMs = workingSince ? Date.now() - workingSince : 0;
      // The elapsed time counts from your last prompt: 'prompt' (re)starts
      // the clock unless it is a wake-up (above), the frequent PostToolUse
      // 'working' repeats only start it when it isn't running, and every
      // other event stops it. Restarting here is what fixes an interrupted
      // turn: Esc fires no hook, so the clock keeps running until the next
      // prompt - which is exactly this branch.
      if (label === 'prompt') {
        promptAt = Date.now();
        if (!wake) workingSince = promptAt;
        label = 'working';
        // A new prompt starts a clean turn: whatever failed in the previous
        // one must not colour this one's ending red.
        lastToolFailed = false;
        sawInterrupt = false;
        lastAssistantText = '';
      } else if (label === 'working') {
        if (!workingSince) workingSince = Date.now();
      } else {
        workingSince = null;
        backgroundWork = false;
      }
      const wasWorking = currentLabel === 'working';
      // 'working' is a lasting state and always visible (even in the active
      // window), never with banner/sound -> no flicker on focus changes
      // while Claude is working.
      if (label === 'working') {
        currentLabel = 'working';
        backgroundWork = heldForBackground;
        clearTimeout(peekTimer); // a running peek must never overwrite a new event
        // Entering 'working' counts agents right away instead of waiting up
        // to a poll tick; the frequent PostToolUse repeats don't re-scan,
        // check() has to stay cheap.
        if (!wasWorking) updateAgentCount();
        setMarker('working');
        return;
      }
      showAttention(label, ranFor, ranMs, why);
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
          e.affectsConfiguration('claudeRadar.markerAgents') ||
          e.affectsConfiguration('claudeRadar.markerShellTask')) &&
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
