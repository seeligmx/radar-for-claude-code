// End-to-end tests for the marker itself: activate() runs against a stubbed
// `vscode` and a fake $HOME, hook events arrive as real marker files, and the
// assertions read the window title variable the extension actually sets.
//
// This is the regression net for 1.1.2. Covered: a dead session and an Esc
// interrupt clear the marker, an absent session registry must NOT, and a turn
// that ended on a failed tool call shows the error marker instead of done.

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
    onDidChangeWindowState: () => ({ dispose() {} }),
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

test('a failed turn says Failed in the banner', async () => {
  startSession();
  await hook('prompt');
  appendResult(true);
  appendAssistant('Das ging schief.');
  await hook('stop');
  assert.match(title, /🔴/);
  assert.match(bannerText(), /Failed/);
});
