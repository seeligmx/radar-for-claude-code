// End-to-end tests for the marker itself: activate() runs against a stubbed
// `vscode` and a fake $HOME, hook events arrive as real marker files, and the
// assertions read the window title variable the extension actually sets.
//
// This is the regression net for 1.1.2. Covered: a dead session and an Esc
// interrupt clear the marker, an absent session registry must NOT, and a turn
// that ended on a failed tool call shows the error marker instead of done.
// Since then: an Esc that leaves background agents running keeps the marker.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-marker-'));
const PROJECT = path.join(HOME, 'work', 'app');
const STATUS = path.join(HOME, '.claude', 'tab-status');
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
for (const d of [PROJECT, STATUS, SESSIONS]) fs.mkdirSync(d, { recursive: true });

os.homedir = () => HOME;

// --- vscode stub -----------------------------------------------------------

let title = null; // whatever setContext last wrote: the visible marker
let focused = false;
const focusListeners = [];
// Bring the window to the front or leave it, the way VS Code reports it.
const setFocus = (value) => {
  focused = value;
  for (const fn of focusListeners) fn({ focused: value });
};
const settings = {};

const vscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: PROJECT }, name: 'app' }],
    getConfiguration: (section) => ({
      get: (key, def) => {
        const v = settings[`${section}.${key}`];
        return v === undefined ? def : v;
      },
      update: async () => {},
      inspect: () => ({}),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    get state() {
      return { focused };
    },
    onDidChangeWindowState: (fn) => {
      focusListeners.push(fn);
      return { dispose() {} };
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  commands: {
    executeCommand: async (cmd, key, value) => {
      if (cmd === 'setContext' && key === 'claudeRadar.status') title = value;
    },
    registerCommand: () => ({ dispose() {} }),
  },
  env: { appRoot: '/nonexistent/Contents/Resources/app' },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};

// Capture the recurring timers instead of waiting on them.
const ticks = [];
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => {
  ticks.push({ fn, ms });
  // A handle nobody fires, unref'd so it never holds the process open.
  return realSetInterval(() => {}, 1 << 30).unref();
};

// Every banner Radar raises, recorded instead of shown. Without this the
// suite would fire real macOS notifications on every run.
const banners = [];
const execFileStub = (...args) => {
  banners.push(args);
  const cb = args[args.length - 1];
  if (typeof cb === 'function') cb(null, '', '');
};

const load = Module._load;
Module._load = (req, ...rest) => {
  if (req === 'vscode') return vscode;
  if (req === 'child_process' || req === 'node:child_process') {
    return { ...load(req, ...rest), execFile: execFileStub };
  }
  return load(req, ...rest);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
Module._load = load;
// setInterval stays patched until activate() has run: that is where the
// extension creates its timers.

// The 10 s sweep is the second interval (after the one-minute clock).
const sweepTick = () => ticks.find((t) => t.ms === 10000).fn();

// --- helpers ---------------------------------------------------------------

const crypto = require('node:crypto');
const markerFile = path.join(
  STATUS,
  crypto.createHash('sha256').update(fs.realpathSync(PROJECT)).digest('hex').slice(0, 16)
);
const transcript = path.join(
  HOME,
  '.claude',
  'projects',
  fs.realpathSync(PROJECT).replace(/[^a-zA-Z0-9]/g, '-'),
  `${SESSION_ID}.jsonl`
);
fs.mkdirSync(path.dirname(transcript), { recursive: true });

const pidFile = path.join(SESSIONS, `${process.pid}.json`);
const startSession = () =>
  fs.writeFileSync(
    pidFile,
    JSON.stringify({ pid: process.pid, sessionId: SESSION_ID, cwd: fs.realpathSync(PROJECT) })
  );
const endSession = () => fs.rmSync(pidFile, { force: true });
// The same entry with the session's own state, as Claude Code 2.1.269+ writes it.
const setStatus = (status, at = Date.now(), extra = {}) =>
  fs.writeFileSync(
    pidFile,
    JSON.stringify({ pid: process.pid, sessionId: SESSION_ID, cwd: fs.realpathSync(PROJECT), status, statusUpdatedAt: at, ...extra })
  );

const userLine = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n';
const appendInterrupt = () => fs.appendFileSync(transcript, userLine([{ type: 'text', text: '[Request interrupted by user]' }]));
const appendAssistant = (text) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  );
const appendResult = (isError) =>
  fs.appendFileSync(transcript, userLine([{ type: 'tool_result', tool_use_id: 't', content: 'x', ...(isError ? { is_error: true } : {}) }]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deliver a hook event the way the hooks do, then let the watcher pick it up.
async function hook(label) {
  banners.length = 0;
  fs.writeFileSync(markerFile, label);
  await sleep(160); // fs.watch + the extension's 50 ms debounce
}

// Did the last hook raise a banner? Reads the recorded arguments, so it also
// covers the osascript fallback when terminal-notifier isn't installed.
const bannerText = () => JSON.stringify(banners);

const subscriptions = [];

before(async () => {
  fs.writeFileSync(transcript, '');
  await ext.activate({ subscriptions, globalState: { get: () => true, update: async () => {} } });
  global.setInterval = realSetInterval;
  await sleep(50);
});

after(() => {
  // The file watcher and the extension's own timers would keep the runner
  // alive forever otherwise.
  for (const s of subscriptions) {
    try {
      s.dispose();
    } catch {
      /* nothing to dispose */
    }
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});

// --- tests -----------------------------------------------------------------

test('a prompt shows the working marker', async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);
});

test('the sweep leaves a healthy session alone', () => {
  sweepTick();
  assert.match(title, /💬/, 'a live session must keep its marker');
});

test('an Esc interrupt clears the marker', () => {
  appendInterrupt();
  sweepTick();
  assert.equal(title, '', 'no marker, and deliberately no done marker either');
});

test('a dead session clears a marker left standing', async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);

  endSession();
  // Another project still has a live session, so the registry stays
  // authoritative: this is "nothing runs here", not "cannot tell".
  const other = path.join(SESSIONS, `${process.pid + 1}.json`);
  fs.writeFileSync(other, JSON.stringify({ pid: process.pid, sessionId: 'x', cwd: '/elsewhere' }));
  sweepTick();
  assert.equal(title, '');
  fs.rmSync(other, { force: true });
});

test('without a session registry the marker is never cleared', async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);

  const parked = SESSIONS + '.parked';
  fs.renameSync(SESSIONS, parked);
  try {
    sweepTick();
    assert.match(title, /💬/, 'an older Claude Code must not lose its markers');
  } finally {
    fs.renameSync(parked, SESSIONS);
  }
});

test('the registry going idle clears a working marker no Stop ever ended', async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);

  setStatus('idle');
  sweepTick();
  assert.equal(title, '', 'ended without a Stop: cleared, and no done banner on a guess');
});

test('an idle older than the prompt is the race at turn start, not an ending', async () => {
  setStatus('idle', Date.now() - 1000);
  await hook('prompt');
  sweepTick();
  assert.match(title, /💬/, 'the CLI just has not written busy yet');
});

test('a busy session keeps the working marker', async () => {
  setStatus('busy');
  await hook('prompt');
  sweepTick();
  assert.match(title, /💬/);
});

test('a marker held for background work survives the idle session', async () => {
  // The Stop hook keeps 'working' while a workflow or background agent runs.
  // The session itself is idle then and says so in the registry; that idle
  // is expected, not an ending.
  startSession();
  await hook('prompt');
  await hook('working\nbackground');
  setStatus('idle');
  sweepTick();
  assert.match(title, /💬/, 'background work holds the marker');

  // The task wakes the session, a tool call fires the plain 'working', and
  // from then on the registry decides again.
  await hook('working');
  sweepTick();
  assert.equal(title, '', 'the plain working handed the verdict back');
});

test('a prompt the hooks missed still shows needs you, with the reason', async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);

  banners.length = 0;
  setStatus('waiting', Date.now(), { waitingFor: 'permission prompt' });
  sweepTick();
  assert.match(title, /⚠️/);
  assert.match(bannerText(), /Needs you: permission prompt/);
  // The next tick must not ring a second time: the marker is now an
  // attention label the sweep leaves alone.
  banners.length = 0;
  sweepTick();
  assert.equal(banners.length, 0);
  startSession(); // back to an entry without state for the tests below
});

test('a turn that ended cleanly shows the done marker', async () => {
  startSession();
  await hook('prompt');
  appendResult(false);
  await hook('stop');
  assert.match(title, /🟢/);
});

test('a turn that ended on a failed tool call shows the error marker', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  await hook('stop');
  assert.match(title, /🔴/);
});

test('an error Claude recovered from still ends green', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  appendResult(false); // retried and worked
  await hook('stop');
  assert.match(title, /🟢/);
});

test('a new prompt clears the error memory of the previous turn', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  await hook('stop');
  assert.match(title, /🔴/);

  await hook('prompt'); // next turn, nothing fails
  await hook('stop');
  assert.match(title, /🟢/, 'the previous failure must not bleed into this turn');
});

test('the error marker respects its setting', async () => {
  settings['claudeRadar.markerError'] = '💥';
  try {
    startSession();
    await hook('prompt');
    appendResult(true);
    await hook('stop');
    assert.match(title, /💥/);
  } finally {
    delete settings['claudeRadar.markerError'];
  }
});

test('an acknowledged marker leaves nothing for the sweep to do', async () => {
  // The idle case, and the reason the README can still promise zero idle cost:
  // a focused window peeks at 'done' and then holds no state at all.
  startSession();
  focused = true;
  try {
    await hook('stop');
    await sleep(1200); // the ~1 s peek expires
    assert.equal(title, '', 'peek is over');
    endSession(); // a dead session would normally clear, but there is nothing left
    sweepTick();
    assert.equal(title, '');
  } finally {
    focused = false;
  }
});

// --- questions and banner noise -------------------------------------------

test('a turn that ends by asking something shows needs you, not done', async () => {
  startSession();
  await hook('prompt');
  appendAssistant('Ich habe zwei Wege gefunden.\n\nSoll ich den ersten nehmen?');
  await hook('stop');
  assert.match(title, /⚠️/, 'a question is not a finished task');
});

test('a question wins over a failed tool call', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  appendAssistant('Das Kommando ist gescheitert. Soll ich es mit sudo versuchen?');
  await hook('stop');
  assert.match(title, /⚠️/, '"answer me" beats "look at this"');
});

test('the very first turn of a new session ends on its question too', async () => {
  // The window has never seen this session's transcript: Claude Code writes
  // it a moment after the first prompt, and a turn shorter than the tick is
  // over before any sweep has looked at it.
  const id = 'ffffffff-1111-2222-3333-444444444444';
  const fresh = path.join(path.dirname(transcript), `${id}.jsonl`);
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId: id, cwd: fs.realpathSync(PROJECT) }));
  try {
    await hook('prompt');
    fs.writeFileSync(
      fresh,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'Ich sehe zwei Kandidaten.\n\nWelche Datei meinst du?' }] },
      }) + '\n'
    );
    await hook('stop');
    assert.match(title, /⚠️/, 'read from its first line, not just measured');
    assert.match(bannerText(), /Needs you/);
  } finally {
    fs.rmSync(fresh, { force: true });
    startSession();
  }
});

test('a question in the middle of the text does not count', async () => {
  startSession();
  await hook('prompt');
  appendAssistant('Warum war das kaputt? Weil der Pfad fehlte.\n\nBehoben und getestet.');
  await hook('stop');
  assert.match(title, /🟢/);
});

test('trailing blank lines do not hide the question', async () => {
  startSession();
  await hook('prompt');
  appendAssistant('Soll ich committen?\n\n   \n');
  await hook('stop');
  assert.match(title, /⚠️/);
});

test('question detection can be turned off', async () => {
  settings['claudeRadar.detectQuestions'] = false;
  try {
    startSession();
    await hook('prompt');
    appendAssistant('Soll ich committen?');
    await hook('stop');
    assert.match(title, /🟢/);
  } finally {
    delete settings['claudeRadar.detectQuestions'];
  }
});

test('the done banner is skipped below the minimum run time', async () => {
  settings['claudeRadar.minDoneSeconds'] = 60; // the test turn lasts milliseconds
  try {
    startSession();
    await hook('prompt');
    appendAssistant('Fertig.');
    await hook('stop');
    assert.match(title, /🟢/, 'the marker still shows');
    assert.equal(banners.length, 0, 'only the banner is held back');
  } finally {
    delete settings['claudeRadar.minDoneSeconds'];
  }
});

test('a question always notifies, however short the turn', async () => {
  settings['claudeRadar.minDoneSeconds'] = 60;
  try {
    startSession();
    await hook('prompt');
    appendAssistant('Soll ich committen?');
    await hook('stop');
    assert.match(title, /⚠️/);
    assert.ok(banners.length > 0, 'a question is never held back');
    assert.match(bannerText(), /Needs you/);
  } finally {
    delete settings['claudeRadar.minDoneSeconds'];
  }
});

test('without a threshold the done banner fires and reports the run time', async () => {
  startSession();
  await hook('prompt');
  appendAssistant('Fertig.');
  await hook('stop');
  assert.ok(banners.length > 0);
  assert.match(bannerText(), /Done/);
});

test('a banner click lands in the workspace window, not in a new one for its first folder', async (t) => {
  // The CLI opens what it is handed. For a window that shows a .code-workspace
  // that is the workspace file; handed the first folder, it opens that folder
  // in a window of its own.
  const clickTarget = () => {
    const args = banners.length ? banners[0][1] : [];
    const i = args.indexOf('-execute');
    return i === -1 ? undefined : args[i + 1];
  };
  const finishTurn = async () => {
    startSession();
    await hook('prompt');
    appendAssistant('Fertig.');
    await hook('stop');
  };
  await finishTurn();
  if (!clickTarget()) return t.skip('no terminal-notifier or no code CLI here: banners are not clickable');
  assert.match(clickTarget(), /work\/app'$/, 'a folder window is reached by its folder');

  vscode.workspace.workspaceFile = { scheme: 'file', fsPath: '/work/team.code-workspace' };
  try {
    await finishTurn();
    assert.match(clickTarget(), /'\/work\/team\.code-workspace'$/);

    vscode.workspace.workspaceFile = { scheme: 'untitled', fsPath: '/untitled-1' };
    await finishTurn();
    assert.equal(clickTarget(), undefined, 'an unsaved workspace has no file to hand over');
    assert.ok(banners[0][1].includes('-activate'), 'so its banner brings the editor to the front');
  } finally {
    delete vscode.workspace.workspaceFile;
  }
});

test('a failed turn says Failed in the banner', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  appendAssistant('Das ging schief.');
  await hook('stop');
  assert.match(title, /🔴/);
  assert.match(bannerText(), /Failed/);
});

// --- a turn that died on Claude's side --------------------------------------

test("a turn that died on Claude's side raises the error marker and names the cause", async () => {
  startSession();
  await hook('prompt');
  assert.match(title, /💬/);

  // Claude Code ends such a turn with StopFailure instead of Stop; the hook
  // writes the label and, on a second line, the message Claude Code shows.
  await hook("error\nYou've hit your monthly spend limit · raise it at claude.ai/settings/usage");
  assert.match(title, /🔴/, 'no more 💬 counting minutes nobody is working');
  assert.match(bannerText(), /monthly spend limit/, 'the banner says why, so you need not switch');
});

test('a StopFailure without a message still shows the error marker', async () => {
  startSession();
  await hook('prompt');
  await hook('error');
  assert.match(title, /🔴/);
  assert.match(bannerText(), /API error/);
});

test('retrying the prompt starts a clean turn', async () => {
  startSession();
  await hook('prompt');
  await hook('error\nAPI Error: 529 Overloaded. This is a server-side issue.');
  assert.match(title, /🔴/);

  await hook('prompt'); // the user simply sends it again
  assert.match(title, /💬/, 'working again, fresh clock');
  banners.length = 0;
  sweepTick();
  assert.match(title, /💬/, 'the previous error must not fire a second time');
});

test('in the focused window the API error peeks instead of ringing', async () => {
  startSession();
  await hook('prompt');
  focused = true;
  try {
    await hook('error\nAPI Error: 529 Overloaded.');
    assert.match(title, /🔴/, 'shown once');
    assert.equal(banners.length, 0, 'never a banner in the window you are looking at');
    await sleep(1200);
    assert.equal(title, '', 'the peek expires');
  } finally {
    focused = false;
  }
});

// --- Esc while agents work in the background ---------------------------------

// Since Claude Code 2.1.286 the VS Code panel's Stop and Esc end the turn and
// nothing else: background agents work on, and the session stays busy in the
// registry while they do. Measured live against 2.1.296.
const AGENTS = path.join(path.dirname(transcript), SESSION_ID, 'subagents');
const agentFile = path.join(AGENTS, 'agent-a0000000000000001.jsonl');
const startAgent = () => {
  fs.mkdirSync(AGENTS, { recursive: true });
  fs.writeFileSync(
    agentFile,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }], stop_reason: 'tool_use' } }) + '\n'
  );
};
const endAgents = () => fs.rmSync(AGENTS, { recursive: true, force: true });

test('an Esc interrupt keeps the marker while a background agent works on', async () => {
  setStatus('busy');
  await hook('prompt');
  startAgent();
  appendInterrupt();
  try {
    sweepTick();
    assert.match(title, /💬/, 'the turn is over, the work is not');
    assert.match(title, /🤖1/);
    sweepTick();
    assert.match(title, /💬/, 'one interrupt is not held against the ticks that follow');

    // The agent finishes and wakes the session: a prompt of its own, then Stop.
    fs.appendFileSync(
      agentFile,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }) + '\n'
    );
    await hook('prompt');
    appendAssistant('Der Agent ist durch.');
    await hook('stop');
    assert.match(title, /🟢/, 'the woken turn ends it the usual way');
  } finally {
    endAgents();
    startSession();
  }
});

test('an Esc interrupt that took its agent down clears the marker', async () => {
  // A foreground agent goes with the turn, and its transcript says so.
  startSession();
  await hook('prompt');
  startAgent();
  fs.appendFileSync(agentFile, userLine([{ type: 'text', text: '[Request interrupted by user for tool use]' }]));
  appendInterrupt();
  try {
    sweepTick();
    assert.equal(title, '', 'nobody is left working');
  } finally {
    endAgents();
  }
});

test('an idle session ends the marker even when a transcript still looks alive', async () => {
  // An agent that died without a last line leaves a mid-work transcript
  // behind. The session knows better: idle since the interrupt means nothing
  // is running, so the marker must not wait out the ten-minute fallback.
  startSession();
  await hook('prompt');
  startAgent();
  appendInterrupt();
  setStatus('idle');
  try {
    sweepTick();
    assert.equal(title, '');
  } finally {
    endAgents();
    startSession();
  }
});

// --- moving the clock -----------------------------------------------------------

// The minute tick refreshes the elapsed time. The clock is moved, not waited on.
const minuteTick = () => ticks.find((t) => t.ms === 60000).fn();
const realNow = Date.now;
const later = (minutes) => {
  Date.now = () => realNow() + minutes * 60000;
};
const backToNow = () => {
  Date.now = realNow;
};

// --- a ⚠️ whose prompt was answered somewhere else -----------------------------

// Nothing fires when a permission is allowed. Answered from a phone or a
// terminal, this window never gets the focus that would acknowledge its ⚠️,
// so it stood until the tool call was through. The registry stamps the moment
// the session goes back to work (measured live against Claude Code 2.1.296).

test('a permission allowed elsewhere turns ⚠️ back into 💬', async () => {
  setStatus('busy');
  await hook('prompt');
  setStatus('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  assert.match(title, /⚠️/);
  try {
    sweepTick();
    assert.match(title, /⚠️/, 'still asking');

    banners.length = 0;
    setStatus('busy'); // allowed: the session stamps its way back to work
    sweepTick();
    assert.equal(title, '💬 ', 'Claude works again, and nobody had to look');
    assert.equal(banners.length, 0, 'working never rings');

    // From here on it is an ordinary working marker.
    later(2);
    minuteTick();
    assert.equal(title, '💬 2m ', 'the clock started over when the work did');
    appendAssistant('Fertig.');
    await hook('stop');
    assert.match(title, /🟢/);
  } finally {
    backToNow();
    startSession();
  }
});

test('a permission prompt rings once, though it is reported twice', async () => {
  startSession();
  await hook('prompt');
  await hook('waiting'); // PermissionRequest
  assert.match(bannerText(), /Needs you/, 'the prompt rings');
  await hook('waiting'); // the Notification for the same prompt, seconds later
  assert.equal(banners.length, 0, 'its second report does not');
  assert.match(title, /⚠️/);
  try {
    later(1);
    await hook('waiting'); // a minute on, that is another prompt
    assert.match(bannerText(), /Needs you/);
  } finally {
    backToNow();
  }
});

test('a repeat of the same ⚠️ does not move the moment it is measured from', async () => {
  // A prompt left open rings twice: PermissionRequest at once, the
  // Notification six seconds later. The answer counts against the first.
  setStatus('busy');
  await hook('prompt');
  await hook('waiting');
  try {
    setStatus('busy'); // answered, stamped after the first ⚠️
    later(1);
    await hook('waiting'); // the late repeat, a minute on in this test's clock
    assert.match(title, /⚠️/);
    sweepTick();
    assert.equal(title, '💬 ', 'the stamp is newer than the ⚠️ it answered');
  } finally {
    backToNow();
    startSession();
  }
});

test('with two sessions the working one leaves the other one\'s ⚠️ alone', async () => {
  // The second session lives in the parent process: a pid that answers.
  const other = path.join(SESSIONS, `${process.ppid}.json`);
  const otherStatus = (status, at = Date.now()) =>
    fs.writeFileSync(other, JSON.stringify({ pid: process.ppid, sessionId: 'other', cwd: fs.realpathSync(PROJECT), status, statusUpdatedAt: at }));
  setStatus('busy');
  await hook('prompt');
  setStatus('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  try {
    otherStatus('busy'); // starts working after the ⚠️ showed
    sweepTick();
    assert.match(title, /⚠️/, 'the first session is still asking');

    setStatus('busy'); // and now it is answered
    sweepTick();
    assert.match(title, /💬/);
  } finally {
    fs.rmSync(other, { force: true });
    startSession();
  }
});

test('a session busy since before the ⚠️ does not answer it', async () => {
  // A question at the end of a turn waits in an idle session. Another session
  // that has been working all along says nothing about it.
  const other = path.join(SESSIONS, `${process.ppid}.json`);
  fs.writeFileSync(
    other,
    JSON.stringify({ pid: process.ppid, sessionId: 'other', cwd: fs.realpathSync(PROJECT), status: 'busy', statusUpdatedAt: Date.now() - 60000 })
  );
  setStatus('busy');
  await hook('prompt');
  appendAssistant('Soll ich den ersten Weg nehmen?');
  await hook('stop');
  setStatus('idle');
  try {
    assert.match(title, /⚠️/);
    sweepTick();
    assert.match(title, /⚠️/, 'the question is still open');
  } finally {
    fs.rmSync(other, { force: true });
    startSession();
  }
});

test('without the status field a ⚠️ waits for its hook as before', async () => {
  startSession(); // an older Claude Code: no status in the registry
  await hook('prompt');
  await hook('waiting');
  sweepTick();
  assert.match(title, /⚠️/);
  await hook('working'); // the tool call ends, PostToolUse reports it
  assert.match(title, /💬/);
});

// --- a background command that outlives the turn -------------------------------

// With shellTasksKeepWorking on, the Stop hook holds the marker for a shell
// task too and says so ('working' plus 'shell'). Radar cannot tell a build
// from a server, so that hold gets a marker of its own and no clock: a 💬
// counting minutes over a preview server claimed work nobody was doing.
// Measured against Claude Code 2.1.296: the session goes idle while the
// command runs, and its end wakes the session with a prompt of its own.

test('a turn that leaves only a command running shows ⏳ and no clock', async () => {
  startSession();
  await hook('prompt');
  try {
    later(9);
    minuteTick();
    assert.equal(title, '💬 9m ');

    await hook('working\nshell'); // the turn is over, the server is still up
    assert.equal(title, '⏳ ', 'something runs, nobody works');
    assert.equal(banners.length, 0, 'a hold never rings');
    later(30);
    minuteTick();
    assert.equal(title, '⏳ ', 'and it does not start counting later either');

    setStatus('idle'); // as measured: the session is idle while the command runs
    sweepTick();
    assert.equal(title, '⏳ ', 'that idle is expected, the command holds the marker');

    await hook('prompt\nwake'); // the command ends and wakes the session
    assert.equal(title, '💬 ', 'Claude is at it again, with a fresh clock');
    appendAssistant('Fertig.');
    await hook('stop');
    assert.match(title, /🟢/);
  } finally {
    backToNow();
    startSession();
  }
});

test('real work in the background keeps 💬 and its clock', async () => {
  startSession();
  await hook('prompt');
  try {
    later(9);
    await hook('working\nbackground'); // an agent or a workflow is still at it
    assert.equal(title, '💬 9m ');
  } finally {
    backToNow();
  }
});

// Each piece of background work that ends wakes the session with a prompt of
// its own. Seen live against Claude Code 2.1.301: one run, four wake-ups in
// its first 24 minutes, and the clock started over at every one of them.

test('a wake-up from background work keeps the clock of its run', async () => {
  startSession();
  await hook('prompt');
  try {
    later(6);
    await hook('working\nbackground');
    await hook('prompt\nwake'); // a command ends while the agent works on
    assert.equal(title, '💬 6m ', 'the same run, the same clock');
    await hook('working\nbackground');
    later(9);
    await hook('prompt\nwake'); // the agent hands back
    appendAssistant('Fertig.');
    await hook('stop');
    assert.match(bannerText(), /Done after 9m/, 'the banner reports the whole run');

    await hook('prompt\nwake'); // woken after the done: a new stretch
    assert.equal(title, '💬 ');
    later(12);
    await hook('working\nbackground');
    await hook('prompt'); // typed: your new ask starts its own clock
    assert.equal(title, '💬 ');
  } finally {
    backToNow();
    startSession();
  }
});

test('a wake-up is not taken down by the idle the hold left behind', async () => {
  // While the marker is held for background work the session can sit idle,
  // and that stamp is newer than the clock the wake-up keeps. Until the CLI
  // has written busy again, it must not read as the end of the turn that
  // has just begun.
  setStatus('busy');
  await hook('prompt');
  try {
    later(6);
    setStatus('idle'); // the turn is over, the background work is not
    await hook('working\nbackground');
    sweepTick();
    assert.equal(title, '💬 6m ', 'held: that idle is expected');

    await hook('prompt\nwake'); // woken, the registry still shows the old idle
    sweepTick();
    assert.equal(title, '💬 6m ', 'the wake-up came after that idle');

    later(7);
    setStatus('idle'); // the woken turn ends, and no Stop arrives
    sweepTick();
    assert.equal(title, '', 'an idle after the wake-up still ends it');
  } finally {
    backToNow();
    startSession();
  }
});

test('the command marker shows no agent count', async () => {
  // The hook says nothing but a command is left. A transcript that still
  // looks alive is a leftover then, and must not put a 🤖 next to the ⏳.
  startSession();
  await hook('prompt');
  startAgent();
  try {
    await hook('working\nshell');
    sweepTick();
    assert.equal(title, '⏳ ');
  } finally {
    endAgents();
  }
});

test('the command marker respects its setting, empty hides it', async () => {
  startSession();
  await hook('prompt');
  try {
    settings['claudeRadar.markerShellTask'] = '🧵';
    await hook('working\nshell');
    assert.equal(title, '🧵 ');
    settings['claudeRadar.markerShellTask'] = '';
    await hook('working\nshell');
    assert.equal(title, '');
  } finally {
    delete settings['claudeRadar.markerShellTask'];
  }
});

test('a prompt answered during a command hold goes back to 💬, not to ⏳', async () => {
  setStatus('busy');
  await hook('prompt');
  await hook('working\nshell');
  assert.equal(title, '⏳ ');
  try {
    setStatus('waiting', Date.now(), { waitingFor: 'permission prompt' });
    sweepTick(); // no hook reported it, the registry does
    assert.match(title, /⚠️/);
    setStatus('busy');
    sweepTick();
    assert.equal(title, '💬 ', 'the session works again, so it is Claude, not just the command');
  } finally {
    startSession();
  }
});

// --- several sessions in one project -----------------------------------------

// Two or three Claudes in one window share the project, and with it one marker
// file. The hooks name the session on a prompt and on a plain done (see
// hooks.test.js), and the registry says what each of them is doing. The second
// session here lives under the pid of the test runner's parent.

const OTHER_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const otherPidFile = path.join(SESSIONS, `${process.ppid}.json`);
const otherTranscript = path.join(path.dirname(transcript), `${OTHER_ID}.jsonl`);
const registryEntry = (file, pid, id, status, at, extra) =>
  fs.writeFileSync(file, JSON.stringify({ pid, sessionId: id, cwd: fs.realpathSync(PROJECT), status, statusUpdatedAt: at, ...extra }));
const mine = (status, at = Date.now(), extra = {}) => registryEntry(pidFile, process.pid, SESSION_ID, status, at, extra);
const other = (status, at = Date.now(), extra = {}) => registryEntry(otherPidFile, process.ppid, OTHER_ID, status, at, extra);
const otherLine = (obj) => fs.appendFileSync(otherTranscript, JSON.stringify({ ...obj, timestamp: new Date().toISOString() }) + '\n');
const otherResult = (isError) =>
  otherLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x', ...(isError ? { is_error: true } : {}) }] } });
const otherSays = (text) => otherLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const otherInterrupt = () =>
  otherLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
// Both at work, both transcripts followed.
async function twoSessions() {
  fs.writeFileSync(otherTranscript, '');
  mine('busy');
  other('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  await hook(`prompt\n\n${OTHER_ID}`);
  sweepTick();
}
const oneSessionAgain = () => {
  fs.rmSync(otherPidFile, { force: true });
  fs.rmSync(otherTranscript, { force: true });
  startSession();
};

test('a turn is judged by its own transcript, not by a neighbour\'s', async () => {
  await twoSessions();
  try {
    otherResult(true); // the neighbour's last tool call failed, and it works on
    appendAssistant('Alles erledigt.');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/, 'this one ended cleanly');
    assert.match(bannerText(), /Done/);

    await hook(`prompt\n\n${SESSION_ID}`);
    otherSays('Was ist hier los?'); // the neighbour thinks aloud
    appendAssistant('Fertig.');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/, 'and its closing words are its own');

    await hook(`stop\n${OTHER_ID}`);
    assert.match(title, /⚠️/, 'the neighbour did end on its question');

    await hook(`prompt\n\n${OTHER_ID}`);
    otherResult(true);
    otherSays('Das hat nicht geklappt.');
    await hook(`stop\n${OTHER_ID}`);
    assert.match(title, /🔴/, 'and its failed tool call is its own, too');

    await hook(`prompt\n\n${SESSION_ID}`); // a prompt here leaves the neighbour's turn alone
    await hook(`prompt\n\n${OTHER_ID}`);
    otherResult(true);
    await hook(`prompt\n\n${SESSION_ID}`);
    appendAssistant('Fertig.');
    await hook(`stop\n${SESSION_ID}`);
    otherSays('Abgebrochen.');
    await hook(`stop\n${OTHER_ID}`);
    assert.match(title, /🔴/, 'what failed there before is still known');
  } finally {
    oneSessionAgain();
  }
});

test('an Esc in one session leaves the marker to the other that works on', async () => {
  await twoSessions();
  try {
    otherInterrupt();
    other('idle');
    sweepTick();
    assert.match(title, /💬/, 'this session is still at it');

    appendInterrupt(); // and now this one, too
    mine('idle');
    sweepTick();
    assert.equal(title, '', 'nobody is left');
  } finally {
    oneSessionAgain();
  }
});

test('an Esc elsewhere takes down neither a done marker nor a prompt that is still open', async () => {
  await twoSessions();
  try {
    appendAssistant('Fertig.');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    otherInterrupt();
    other('idle');
    sweepTick();
    assert.match(title, /🟢/, 'that turn had ended before');

    await twoSessions();
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting');
    otherInterrupt();
    other('idle');
    sweepTick();
    assert.match(title, /⚠️/, 'the prompt here is still open');

    appendInterrupt(); // Esc on the prompt itself
    mine('idle');
    sweepTick();
    assert.equal(title, '', 'dismissed');
  } finally {
    oneSessionAgain();
  }
});

test('a prompt that is still open keeps its ⚠️ while a neighbour works on', async () => {
  await twoSessions();
  try {
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting');
    assert.match(title, /⚠️/);
    await hook('working'); // a tool call over there
    assert.match(title, /⚠️/, 'somebody still needs you');
    assert.equal(banners.length, 0);

    otherSays('Fertig.');
    other('idle');
    await hook(`stop\n${OTHER_ID}`); // the neighbour is done
    assert.match(title, /⚠️/, 'done over there does not answer the prompt here');
    assert.match(bannerText(), /Done/, 'but it rings');

    mine('busy'); // answered
    await hook('working');
    assert.match(title, /💬/);
  } finally {
    oneSessionAgain();
  }
});

test('a closing question keeps its ⚠️ until that session is prompted again', async () => {
  await twoSessions();
  try {
    appendAssistant('Soll ich das so machen?');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /⚠️/);
    await hook('working'); // the neighbour's tool call
    assert.match(title, /⚠️/, 'the question is still open');
    await hook(`prompt\n\n${OTHER_ID}`); // even a prompt over there
    assert.match(title, /⚠️/);

    other('busy'); // stamped after the question: work starting next door
    sweepTick();
    assert.match(title, /⚠️/, 'is no answer to it either');

    await hook(`prompt\n\n${SESSION_ID}`); // the answer
    assert.match(title, /💬/);
  } finally {
    oneSessionAgain();
  }
});

test('a single session goes from ⚠️ back to 💬 with its next tool call, as before', async () => {
  // The registry no longer shows it waiting once the prompt is answered.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  assert.match(title, /⚠️/);
  mine('busy');
  await hook('working');
  assert.match(title, /💬/);
  startSession();
});

// --- what is left once a marker has been seen --------------------------------

// Looking at the window acknowledges ⚠️, 🟢 and 🔴. What happens after that is
// not for a hook to say: nothing fires when a prompt is answered, and nothing
// when you look away again while another session works on.

test('a ⚠️ you looked at turns into 💬 once its prompt is answered', async () => {
  // Seen live: the prompt stood for 24 s, the allowed command then ran for
  // 40 s, and the tab stayed empty until it was through.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  assert.match(title, /⚠️/);
  try {
    setFocus(true); // you look, the prompt is still open
    assert.equal(title, '');
    sweepTick();
    assert.equal(title, '', 'nothing to show while it waits for you');

    mine('busy'); // allowed
    sweepTick();
    assert.match(title, /💬/, 'the command runs, and the title says so');
    setFocus(false);
    assert.match(title, /💬/);
  } finally {
    setFocus(false);
    startSession();
  }
});

test('a prompt that comes up while you watch does the same', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  setFocus(true);
  try {
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting');
    assert.match(title, /⚠️/, 'a peek');
    await sleep(1100);
    assert.equal(title, '');

    mine('busy'); // allowed
    sweepTick();
    assert.match(title, /💬/);
  } finally {
    setFocus(false);
    startSession();
  }
});

test('a prompt that was dismissed leaves the title empty, and the check ends', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  try {
    setFocus(true);
    later(1);
    mine('idle'); // Esc on the prompt: the turn is over
    sweepTick();
    assert.equal(title, '');
    mine('busy'); // whatever comes later is for its own hooks to report
    sweepTick();
    assert.equal(title, '', 'the check is not waiting for an answer any more');
  } finally {
    backToNow();
    setFocus(false);
    startSession();
  }
});

test('one session done leaves the clock to the one that works on', async () => {
  fs.writeFileSync(otherTranscript, '');
  mine('busy');
  other('idle');
  await hook(`prompt\n\n${SESSION_ID}`);
  try {
    later(5);
    other('busy');
    await hook(`prompt\n\n${OTHER_ID}`);
    assert.equal(title, '💬 5m ', 'a prompt next door does not restart the clock');

    later(20);
    appendAssistant('Fertig.');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    assert.match(bannerText(), /Done after 20m/);

    await hook('working'); // the neighbour's next tool call
    assert.equal(title, '💬 20m ', 'the project has been busy all along');

    later(30);
    otherSays('Fertig.');
    other('idle');
    await hook(`stop\n${OTHER_ID}`);
    assert.match(bannerText(), /Done after 25m/, 'the banner reports the turn that ended, not the project');

    await hook(`prompt\n\n${SESSION_ID}`);
    assert.equal(title, '💬 ', 'nobody else at work: your prompt starts the clock');
  } finally {
    backToNow();
    oneSessionAgain();
  }
});

test('a done you looked at gives the title back to the session that works on', async () => {
  await twoSessions();
  try {
    appendAssistant('Fertig.');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    setFocus(true);
    assert.match(title, /💬/, 'seen, and the neighbour is still at it');
    setFocus(false);
    assert.match(title, /💬/);

    // The same while you watch: a peek, then 💬 again.
    await hook(`prompt\n\n${SESSION_ID}`);
    setFocus(true);
    appendAssistant('Fertig.');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    await sleep(1100);
    assert.match(title, /💬/);
  } finally {
    setFocus(false);
    oneSessionAgain();
  }
});

test('with the neighbour gone quiet, a done you looked at leaves nothing behind', async () => {
  await twoSessions();
  try {
    appendAssistant('Fertig.');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    other('idle'); // its turn ended without a Stop
    sweepTick();
    assert.match(title, /🟢/, 'your done still stands');
    setFocus(true);
    assert.equal(title, '');
  } finally {
    setFocus(false);
    oneSessionAgain();
  }
});

test('one session alone: a done you looked at leaves the title empty, as before', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  appendAssistant('Fertig.');
  await hook(`stop\n${SESSION_ID}`); // the registry still says busy: the Stop hooks have not all returned
  assert.match(title, /🟢/);
  setFocus(true);
  assert.equal(title, '', 'the session that stopped is not "someone else at work"');
  setFocus(false);
  startSession();
});

test('a session sent back to work after its closing question gives the ⚠️ up', async () => {
  // A Stop hook can refuse the ending and make Claude carry on; loops built on
  // that do it after every turn. The question then is not waiting for anyone.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  try {
    appendAssistant('Soll ich weitermachen?');
    await hook(`stop\n${SESSION_ID}`); // the registry says busy: its Stop hooks are still running
    assert.match(title, /⚠️/);
    await hook('working'); // a tool call next door, within that moment
    assert.match(title, /⚠️/, 'too early to tell');

    later(1);
    appendAssistant('Dann mache ich weiter.'); // sent back to work, it has a word of its own again
    await hook('working'); // and is still busy a minute on
    assert.match(title, /💬/);

    backToNow();
    appendAssistant('Und jetzt?');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /⚠️/);
    later(1);
    appendAssistant('Weiter im Text.');
    sweepTick(); // the same, noticed without any hook
    assert.match(title, /💬/);

    backToNow();
    appendAssistant('Noch eine Frage?');
    await hook(`stop\n${SESSION_ID}`);
    appendAssistant('Fertig.');
    await hook(`stop\n${SESSION_ID}`); // its next ending is the one that counts
    assert.match(title, /🟢/);
  } finally {
    backToNow();
    startSession();
  }
});

test('a prompt seen the moment it came up is still waited for', async () => {
  // Measured against Claude Code 2.1.296: the hook fires at once, the registry
  // says waiting 0.3 s later. A check that runs in between must not conclude
  // that the prompt is gone.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  setFocus(true);
  try {
    await hook('waiting');
    sweepTick(); // the registry still says busy
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await sleep(1100);
    assert.equal(title, '');
    mine('busy'); // allowed
    sweepTick();
    assert.match(title, /💬/);
  } finally {
    setFocus(false);
    startSession();
  }
});

// --- what a turn leaves behind for the next prompt -----------------------------

// An Esc fires no hook. Its line sits in the transcript until somebody reads
// it, and a prompt that comes first must not inherit it.

test('an Esc nobody had read yet does not take down the next prompt', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  sweepTick(); // the transcript is followed from here on
  try {
    appendInterrupt(); // Esc, and the correction is typed at once
    await hook(`prompt\n\n${SESSION_ID}`);
    sweepTick();
    assert.match(title, /💬/, 'that Esc ended the turn before, not this one');

    appendInterrupt(); // an Esc in the new turn still counts
    mine('idle');
    sweepTick();
    assert.equal(title, '');
  } finally {
    startSession();
  }
});

test('the same on the first turn the window sees', async () => {
  // A new session, or a window just reloaded: the transcript is met at the
  // first sweep, and the last seconds of it are read then.
  const id = 'cccccccc-5555-6666-7777-888888888888';
  const fresh = path.join(path.dirname(transcript), `${id}.jsonl`);
  const freshLine = (content) =>
    fs.appendFileSync(fresh, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } }) + '\n');
  registryEntry(pidFile, process.pid, id, 'busy', Date.now());
  await hook(`prompt\n\n${id}`);
  try {
    freshLine('Bau das um');
    freshLine([{ type: 'text', text: '[Request interrupted by user]' }]); // Esc
    await hook(`prompt\n\n${id}`); // and the correction right behind it
    freshLine('Nein, anders');
    sweepTick(); // the first look at this transcript
    assert.match(title, /💬/, 'the Esc belongs to the turn before');
  } finally {
    fs.rmSync(fresh, { force: true });
    startSession();
  }
});

test('a closing question outlasts Stop hooks that take their time', async () => {
  // A session reads busy until the last of its Stop hooks is through, and one
  // of the user's own can run for many seconds: tests, a linter, a summary.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  try {
    appendAssistant('Soll ich das so machen?');
    await hook(`stop\n${SESSION_ID}`); // the registry still says busy
    assert.match(title, /⚠️/);

    later(0.2); // twelve seconds on, a hook is still at it
    sweepTick();
    assert.match(title, /⚠️/, 'busy without a word of its own is not back at work');

    mine('idle'); // the last hook is through
    sweepTick();
    assert.match(title, /⚠️/, 'and the question still waits for its answer');
  } finally {
    backToNow();
    startSession();
  }
});

// --- a prompt that was dismissed, or answered next to a question ---------------

// Esc on a prompt fires no hook either. What the title shows after it depends
// on what is left: a question another session closed on, a neighbour at work,
// or nothing.

test('a prompt dismissed the moment before a sweep is not left standing', async () => {
  // The registry follows the Esc by about 0.3 s. A sweep in between reads the
  // interrupt while the entry still says waiting.
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  sweepTick();
  mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting');
  assert.match(title, /⚠️/);
  try {
    appendInterrupt(); // Esc on the prompt, the entry has not followed yet
    sweepTick();
    assert.equal(title, '', 'the transcript says it was dismissed');
  } finally {
    startSession();
  }
});

test('a dismissed prompt hands the title back to the neighbour that works on', async () => {
  await twoSessions();
  try {
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting');
    assert.match(title, /⚠️/);
    await hook('working'); // the neighbour's tool call, held back
    appendInterrupt(); // Esc on the prompt here
    mine('idle');
    sweepTick();
    assert.match(title, /💬/, 'the neighbour is still at it');
  } finally {
    oneSessionAgain();
  }
});

test('a dismissed prompt leaves a closing question that is still owed', async () => {
  await twoSessions();
  try {
    appendAssistant('Soll ich das so machen?');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /⚠️/);
    other('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting'); // the neighbour asks for a permission
    otherInterrupt(); // and gets an Esc for it
    other('idle');
    sweepTick();
    assert.match(title, /⚠️/, 'the question here was never answered');

    await hook(`prompt\n\n${SESSION_ID}`); // now it is
    assert.match(title, /💬/);
  } finally {
    oneSessionAgain();
  }
});

test('a prompt answered elsewhere is noticed after a question came and went', async () => {
  await twoSessions();
  try {
    other('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting'); // the neighbour's prompt
    appendAssistant('Soll ich das so machen?');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`); // a question on top of it
    mine('busy');
    await hook(`prompt\n\n${SESSION_ID}`); // answered
    assert.match(title, /⚠️/, 'the prompt next door is still open');

    other('busy'); // allowed from a phone: no hook says so
    sweepTick();
    assert.match(title, /💬/, 'nobody is waiting any more');
  } finally {
    oneSessionAgain();
  }
});

test('a second prompt rings, however soon after the first one was answered', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
  await hook('waiting'); // PermissionRequest
  assert.match(bannerText(), /Needs you/);
  try {
    mine('busy'); // answered from elsewhere: no hook, and no sweep has run yet
    await hook('waiting'); // the next prompt, seconds after the first
    assert.match(bannerText(), /Needs you/, 'another prompt is news');
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting'); // and its own Notification
    assert.equal(banners.length, 0, 'which is not');
    assert.match(title, /⚠️/);

    startSession(); // an older Claude Code: no status to read, the time alone decides
    await hook('waiting');
    assert.equal(banners.length, 0, 'as before');
  } finally {
    startSession();
  }
});

// --- a session in a folder below -----------------------------------------------

// A window on a folder also finds the sessions of the folders below it. With
// a window of its own open there, such a session writes that window's marker.
// Here it keeps a marker alive, and that is all.

const sessionBelow = (status, at = Date.now(), extra = {}) =>
  fs.writeFileSync(
    otherPidFile,
    JSON.stringify({ pid: process.ppid, sessionId: OTHER_ID, cwd: path.join(fs.realpathSync(PROJECT), 'packages', 'web'), status, statusUpdatedAt: at, ...extra })
  );

test('a session in a folder below keeps a marker alive, and is no neighbour', async () => {
  sessionBelow('busy');
  endSession();
  await hook('working');
  sweepTick();
  assert.match(title, /💬/, 'somebody lives under this folder');

  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  sweepTick();
  try {
    appendInterrupt(); // Esc here
    mine('idle');
    sweepTick();
    assert.equal(title, '', 'the work down there has a window of its own to show it');
  } finally {
    oneSessionAgain();
  }
});

test('it neither takes the title back after a done you looked at, nor holds a prompt that was answered', async () => {
  sessionBelow('busy');
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  try {
    appendAssistant('Fertig.');
    mine('idle');
    await hook(`stop\n${SESSION_ID}`);
    assert.match(title, /🟢/);
    setFocus(true);
    assert.equal(title, '', 'nobody else works in this folder');
    setFocus(false);

    mine('busy');
    await hook(`prompt\n\n${SESSION_ID}`);
    mine('waiting', Date.now(), { waitingFor: 'permission prompt' });
    await hook('waiting');
    sessionBelow('waiting', Date.now(), { waitingFor: 'permission prompt' }); // a prompt of its own down there
    mine('busy'); // the one here is answered
    await hook('working');
    assert.match(title, /💬/, 'the prompt down there is not for this window to show');
  } finally {
    setFocus(false);
    oneSessionAgain();
  }
});

test('deactivate clears the title, and a closing window cancelling the call is no error', async () => {
  mine('busy');
  await hook(`prompt\n\n${SESSION_ID}`);
  assert.match(title, /💬/);
  await ext.deactivate();
  assert.equal(title, '');
  // What VS Code does to the call while the extension host shuts down.
  const real = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async () => {
    throw new Error('Canceled');
  };
  try {
    await ext.deactivate();
  } finally {
    vscode.commands.executeCommand = real;
    startSession();
  }
});
