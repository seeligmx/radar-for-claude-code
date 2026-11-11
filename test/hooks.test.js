// The hook commands themselves, run through /bin/sh the way Claude Code runs
// them: a fake $HOME, the event payload on stdin, and the marker file they
// leave behind. Three PATHs cover the jq branch, the python3 fallback, and a
// Mac with neither. Plus the reconcile: what "installed" means has to include
// the async flag, or a 1.1.x installation would never be brought up to date.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-hooks-'));
const PROJECT = path.join(HOME, 'work', 'app');
const STATUS = path.join(HOME, '.claude', 'tab-status');
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(STATUS, { recursive: true });
os.homedir = () => HOME;

const SRC = path.join(__dirname, '..', 'extension.js');
const COPY = path.join(HOME, 'extension.under-test.js');
fs.writeFileSync(COPY, fs.readFileSync(SRC, 'utf8') + '\nmodule.exports.__test = { HOOK_SPECS, hooksInstalled, installHooks };\n');
const load = Module._load;
Module._load = (req, ...rest) =>
  req === 'vscode'
    ? { workspace: {}, window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined }, commands: {} }
    : load(req, ...rest);
const { HOOK_SPECS, hooksInstalled, installHooks } = require(COPY).__test;
Module._load = load;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

const markerFile = path.join(
  STATUS,
  crypto.createHash('sha256').update(fs.realpathSync(PROJECT)).digest('hex').slice(0, 16)
);

// --- the three PATHs -------------------------------------------------------

const which = (name) => spawnSync('/usr/bin/which', [name]).stdout.toString().trim();
// The hook scripts call cat, grep, jq and python3 by name; everything else by
// absolute path. A bin dir with just some of them makes the others "missing".
const binDir = (tools) => {
  const d = fs.mkdtempSync(path.join(HOME, 'bin-'));
  for (const t of tools) fs.symlinkSync(which(t), path.join(d, t));
  return d;
};
const PATHS = { python3: binDir(['cat', 'grep', 'python3']), neither: binDir(['cat', 'grep']) };
if (which('jq')) PATHS.jq = binDir(['cat', 'grep', 'jq', 'python3']);
else console.log('# jq not installed here, the jq branch is not exercised');

function run(event, stdin, PATH) {
  fs.rmSync(markerFile, { force: true });
  const spec = HOOK_SPECS.find((s) => s.event === event);
  assert.ok(spec, `no hook for ${event}`);
  const r = spawnSync('/bin/sh', ['-c', spec.command], {
    input: stdin,
    env: { HOME, PATH, CLAUDE_PROJECT_DIR: PROJECT },
  });
  assert.equal(r.status, 0, r.stderr.toString());
  return fs.readFileSync(markerFile, 'utf8');
}

const stopPayload = (tasks) =>
  // last_assistant_message deliberately contains the status words: only
  // background_tasks may decide, never free text.
  JSON.stringify({ background_tasks: tasks, last_assistant_message: 'status running, pending review' });

for (const [name, PATH] of Object.entries(PATHS)) {
  const parser = name !== 'neither';

  test(`[${name}] every fixed-label hook writes its label`, () => {
    const fixed = [
      ['Notification', 'waiting'],
      ['PermissionRequest', 'waiting'],
      ['PreToolUse', 'waiting'],
      ['PostToolUse', 'working'],
      ['PostToolUseFailure', 'working'], // Claude reads the error and carries on
    ];
    for (const [event, label] of fixed) assert.equal(run(event, '{}', PATH), label, event);
  });

  test(`[${name}] a prompt the session sent itself says so`, () => {
    // The openings as measured against Claude Code 2.1.299, see WAKE_PREFIXES.
    const prompt = (p) => run('UserPromptSubmit', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: p }), PATH);
    const wake = parser ? 'prompt\nwake' : 'prompt';
    assert.equal(prompt('<task-notification>\n<task-id>b611qeled</task-id>'), wake, 'a background command ended');
    assert.equal(prompt('<agent-message from="a12f3c37fdcb5bda2">\n[Subagent hand-back]'), wake, 'an agent handed back');
    assert.equal(prompt('Another Claude session sent a message:\n<agent-message from="a1">'), wake, 'as the transcript words it');
    assert.equal(prompt('Bau mir das bitte'), 'prompt');
    assert.equal(prompt('Was heißt <task-notification> hier?'), 'prompt', 'typed text that mentions it');
    assert.equal(run('UserPromptSubmit', '{}', PATH), 'prompt');
    assert.equal(run('UserPromptSubmit', 'not json at all', PATH), 'prompt');
  });

  test(`[${name}] Stop: done, unless background work is still running`, () => {
    assert.equal(run('Stop', stopPayload([]), PATH), 'stop');
    const sub = stopPayload([{ type: 'subagent', status: 'running' }]);
    const shell = stopPayload([{ type: 'shell', status: 'running' }]);
    if (!parser) {
      assert.equal(run('Stop', sub, PATH), 'stop', 'no parser: done, as before the feature');
      return;
    }
    // The second line tells the extension the marker is held for background
    // work, whose idle session must not read as an ended turn.
    assert.equal(run('Stop', sub, PATH), 'working\nbackground');
    assert.equal(run('Stop', shell, PATH), 'stop', 'a dev server must not hold the marker');
    fs.writeFileSync(path.join(STATUS, '.shell-keeps-working'), '');
    try {
      // With the setting on a shell task holds too, but says what it is: a
      // command still running is not Claude still working.
      assert.equal(run('Stop', shell, PATH), 'working\nshell', 'unless the setting says so');
    } finally {
      fs.unlinkSync(path.join(STATUS, '.shell-keeps-working'));
    }
  });

  test(`[${name}] Stop: the hold names what is left running`, () => {
    if (!parser) return; // without a parser every Stop is done, see above
    const task = (type, status = 'running') => ({ ...(type ? { type } : {}), status });
    const held = (tasks) => run('Stop', stopPayload(tasks), PATH);
    fs.writeFileSync(path.join(STATUS, '.shell-keeps-working'), '');
    try {
      assert.equal(held([task('shell'), task('shell', 'pending')]), 'working\nshell', 'nothing but commands');
      assert.equal(held([task('shell'), task('subagent')]), 'working\nbackground', 'real work outranks a command');
      assert.equal(held([task('workflow'), task('shell')]), 'working\nbackground', 'in either order');
      assert.equal(held([task('shell', 'completed'), task('monitor', 'in_progress')]), 'working\nbackground');
      assert.equal(held([task('shell', 'completed')]), 'stop', 'a finished command holds nothing');
      assert.equal(held([task(undefined)]), 'working\nbackground', 'no type: an older Claude Code, counts as work');
      assert.equal(held([{ type: 'shell', state: 'running' }]), 'working\nshell', 'state instead of status');
    } finally {
      fs.unlinkSync(path.join(STATUS, '.shell-keeps-working'));
    }
    // Setting off: a command never holds, with or without company.
    assert.equal(held([task('shell'), task('shell')]), 'stop');
    assert.equal(held([task('shell'), task('subagent')]), 'working\nbackground');
    assert.equal(run('Stop', 'not json at all', PATH), 'stop', 'a payload nobody can read is a plain done');
  });

  test(`[${name}] a turn that died on Claude's side writes error plus the reason`, () => {
    const msg = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
    const full = JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: msg });
    assert.equal(run('StopFailure', full, PATH), parser ? 'error\n' + msg : 'error\n');
    // Only the error class, no message: still better than nothing.
    assert.equal(run('StopFailure', JSON.stringify({ error: 'server_error' }), PATH), parser ? 'error\nserver_error' : 'error\n');
    assert.equal(run('StopFailure', '{}', PATH), 'error\n');
  });
}

// --- install and reconcile -------------------------------------------------

test('only the per-tool-call hook is async', () => {
  assert.deepEqual(
    HOOK_SPECS.filter((s) => s.async).map((s) => s.event),
    ['PostToolUse'],
    'the events that can block or decide stay synchronous'
  );
});

test('the async flag is part of what "installed" means', async () => {
  await installHooks();
  assert.equal(hooksInstalled(), true);

  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const own = json.hooks.PostToolUse.find((g) => g.hooks.some((h) => h.command.includes('tab-status')));
  assert.equal(own.hooks[0].async, true, 'the per-tool-call hook never makes Claude wait');

  delete own.hooks[0].async; // what a 1.1.x installation looks like
  fs.writeFileSync(settingsPath, JSON.stringify(json));
  assert.equal(hooksInstalled(), false, 'so the update has to reconcile it');

  await installHooks(true);
  assert.equal(hooksInstalled(), true);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.hooks.PostToolUse[0].hooks[0].async, true);
  assert.equal(after.hooks.PostToolUse.length, 1, 'reconcile replaces, it does not stack');
});

// After an update every open window reconciles the hooks as it activates, and
// on a cold start they all do it within the same moment. Each one is a child
// process here, held at a common start time so they really collide.
const WINDOW = `
  const os = require('os'), Module = require('module');
  const [copy, home, startAt] = process.argv.slice(1);
  os.homedir = () => home;
  const load = Module._load;
  Module._load = (req, ...rest) =>
    req === 'vscode'
      ? { workspace: {}, window: { showInformationMessage: async () => undefined, showErrorMessage: async () => undefined }, commands: {} }
      : load(req, ...rest);
  const { installHooks } = require(copy).__test;
  while (Date.now() < Number(startAt)) {}
  installHooks(true).then(() => process.stdout.write('ok'), (e) => process.stdout.write(String(e.code || e)));
`;

test('windows that update the hooks in the same moment do not trip over each other', async () => {
  const { spawn } = require('node:child_process');
  for (let round = 0; round < 3; round++) {
    const home = fs.mkdtempSync(path.join(HOME, 'cold-start-'));
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath));
    // What an older Radar left behind, next to a hook and a setting of the user's own.
    const before = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo stop > ~/.claude/tab-status/x' }, { type: 'command', command: 'echo mine' }] }] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });

    const startAt = Date.now() + 400;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise((resolve) => {
          let out = '';
          const child = spawn(process.execPath, ['-e', WINDOW, COPY, home, String(startAt)]);
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.on('close', () => resolve(out));
        })
      )
    );
    assert.deepEqual(results, Array(6).fill('ok'), 'no window fails on what another one did');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(after.permissions, before.permissions, 'the rest of the settings is untouched');
    assert.ok(after.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'echo mine')), 'the user\'s own hook survives');
    for (const spec of HOOK_SPECS) {
      const own = (after.hooks[spec.event] || []).flatMap((g) => g.hooks).filter((h) => h.command.includes('tab-status'));
      assert.deepEqual(own.map((h) => h.command), [spec.command], `${spec.event} is installed once, and current`);
    }
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, 'and still private');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(settingsPath + '.claude-radar.bak', 'utf8')), 'the backup is a whole file');
    assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)).sort(), ['settings.json', 'settings.json.claude-radar.bak'], 'no temp file is left behind');
  }
});
