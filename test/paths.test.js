// The window and the hook have to name the same marker file, however the
// folder is spelled. VS Code hands the window the path as it was typed or
// picked: another case on a case-insensitive volume, an umlaut in one piece or
// as letter plus accent. Claude Code hands its hooks one spelling only,
// measured against 2.1.322 by starting it in such folders: symlinks resolved,
// the case the disk stores, composed (NFC). The real hook command runs here,
// against a fake $HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-paths-'));
const STATUS = path.join(HOME, '.claude', 'tab-status');
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const WORK = path.join(HOME, 'work');
for (const d of [STATUS, SESSIONS, WORK]) fs.mkdirSync(d, { recursive: true });
os.homedir = () => HOME;

const vscode = { workspace: { workspaceFolders: [] }, window: {}, commands: {} };
const SRC = path.join(__dirname, '..', 'extension.js');
const COPY = path.join(HOME, 'extension.under-test.js');
fs.writeFileSync(
  COPY,
  fs.readFileSync(SRC, 'utf8') + '\nmodule.exports.__test = { HOOK_SPECS, markerFile, projectRoot, agentTranscriptRoot, liveSessionsHere, slugFor };\n'
);
const load = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscode : load(req, ...rest));
const { HOOK_SPECS, markerFile, projectRoot, agentTranscriptRoot, liveSessionsHere, slugFor } = require(COPY).__test;
Module._load = load;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

// What VS Code reports for the window's folder.
const openFolder = (fsPath) => {
  vscode.workspace.workspaceFolders = [{ uri: { fsPath }, name: path.basename(fsPath) }];
};

// The folder as Claude Code spells it when started there: a process sees its
// working directory the way the disk stores it, and Claude Code resolves the
// symlinks and composes the result.
const claudeSpelling = (startedIn) =>
  spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").realpathSync(process.cwd()).normalize("NFC"))'], {
    cwd: startedIn,
  }).stdout.toString();

// The marker file a hook leaves behind for a session started in `dir`.
function hookMarker(dir) {
  for (const n of fs.readdirSync(STATUS)) fs.rmSync(path.join(STATUS, n));
  const spec = HOOK_SPECS.find((s) => s.event === 'PostToolUse');
  const r = spawnSync('/bin/sh', ['-c', spec.command], {
    input: '{}',
    env: { HOME, PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: claudeSpelling(dir) },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  const written = fs.readdirSync(STATUS);
  assert.equal(written.length, 1, 'exactly one marker file');
  return path.join(STATUS, written[0]);
}

const session = (cwd) =>
  fs.writeFileSync(path.join(SESSIONS, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's', cwd }));

// One folder, and the ways it can be spelled: `stored` is what the disk holds,
// the others only resolve where the volume folds the difference, which is the
// macOS default. Elsewhere there is nothing to test.
const FOLDERS = [
  { what: 'another case', stored: 'MyProject', others: ['myproject', 'MYPROJECT'] },
  { what: 'an umlaut the disk keeps as letter plus accent', stored: 'Büro'.normalize('NFD'), others: ['Büro'.normalize('NFC')] },
  { what: 'an umlaut the disk keeps in one piece', stored: 'Räume'.normalize('NFC'), others: ['Räume'.normalize('NFD')] },
];

for (const { what, stored, others } of FOLDERS) {
  const onDisk = path.join(WORK, stored);
  fs.mkdirSync(onDisk, { recursive: true });
  const spellings = [onDisk, ...others.map((o) => path.join(WORK, o))];
  const folds = spellings.every((s) => fs.existsSync(s)) && fs.readdirSync(WORK).includes(stored);
  const skip = !folds && 'the volume keeps these spellings apart';

  test(`${what}: the window finds the marker its hook writes`, { skip }, () => {
    for (const reported of spellings) {
      openFolder(reported);
      for (const startedIn of spellings) {
        assert.equal(markerFile(), hookMarker(startedIn), `window opened as ${path.basename(reported)}, Claude started in ${path.basename(startedIn)}`);
      }
    }
  });

  test(`${what}: a session there belongs to the window`, { skip }, () => {
    // A session counted as gone takes a live marker with it at the next sweep.
    for (const reported of spellings) {
      openFolder(reported);
      for (const startedIn of spellings) {
        session(claudeSpelling(startedIn));
        assert.equal(liveSessionsHere(projectRoot()).length, 1, `${path.basename(reported)} and ${path.basename(startedIn)}`);
        session(startedIn); // a registry that kept the spelling it was given
        assert.equal(liveSessionsHere(projectRoot()).length, 1, 'whatever the session reports');
      }
      fs.mkdirSync(path.join(onDisk, 'src'), { recursive: true });
      session(claudeSpelling(path.join(reported, 'src')));
      assert.equal(liveSessionsHere(projectRoot()).length, 1, 'a subfolder of it as well');
    }
  });

  test(`${what}: the agents are looked for where Claude Code keeps its transcripts`, { skip }, () => {
    for (const reported of spellings) {
      openFolder(reported);
      assert.equal(path.basename(agentTranscriptRoot()), slugFor(claudeSpelling(onDisk)), path.basename(reported));
    }
  });
}

test('a folder reached through a symlink gets the marker its hook writes', () => {
  const real = path.join(WORK, 'real');
  const link = path.join(WORK, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  openFolder(link);
  assert.equal(markerFile(), hookMarker(real));
  assert.equal(markerFile(), hookMarker(link));
});

test('a folder that is gone keeps a stable marker name', () => {
  openFolder(path.join(WORK, 'deleted'));
  assert.equal(projectRoot(), path.join(WORK, 'deleted'), 'unresolvable: the path as reported');
  assert.match(path.basename(markerFile()), /^[0-9a-f]{16}$/);
});
