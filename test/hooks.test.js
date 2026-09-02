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
      ['UserPromptSubmit', 'prompt'],
      ['Notification', 'waiting'],
      ['PermissionRequest', 'waiting'],
      ['PreToolUse', 'waiting'],
      ['PostToolUse', 'working'],
    ];
    for (const [event, label] of fixed) assert.equal(run(event, '{}', PATH), label, event);
  });

  test(`[${name}] Stop: done, unless background work is still running`, () => {
    assert.equal(run('Stop', stopPayload([]), PATH), 'stop');
    const sub = stopPayload([{ type: 'subagent', status: 'running' }]);
    const shell = stopPayload([{ type: 'shell', status: 'running' }]);
    if (!parser) {
      assert.equal(run('Stop', sub, PATH), 'stop', 'no parser: done, as before the feature');
      return;
    }
    assert.equal(run('Stop', sub, PATH), 'working');
    assert.equal(run('Stop', shell, PATH), 'stop', 'a dev server must not hold the marker');
    fs.writeFileSync(path.join(STATUS, '.shell-keeps-working'), '');
    try {
      assert.equal(run('Stop', shell, PATH), 'working', 'unless the setting says so');
    } finally {
      fs.unlinkSync(path.join(STATUS, '.shell-keeps-working'));
    }
  });

  test(`[${name}] a failed tool call keeps working, an aborted one clears`, () => {
    assert.equal(run('PostToolUseFailure', JSON.stringify({ tool_name: 'Bash', error: 'exit 1' }), PATH), 'working');
    const aborted = JSON.stringify({ tool_name: 'Bash', error: 'interrupted', is_interrupt: true });
    assert.equal(run('PostToolUseFailure', aborted, PATH), parser ? 'interrupt' : 'working');
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
