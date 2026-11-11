// Tests for the two read-only detectors added in 1.1.2: which Claude sessions
// are alive in a project, and what their transcripts say about interrupts and
// failed tool calls.
//
// Run with `npm test` (or `node --test test/`). No dependencies: the extension
// is loaded with a stubbed `vscode` module and a fake $HOME, then the internals
// under test are re-exported from a temporary copy. That way the tests exercise
// the shipped code instead of a paraphrase of it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-'));
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const PROJECTS = path.join(HOME, '.claude', 'projects');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });

// The extension reads os.homedir() at load time, so redirect it first.
os.homedir = () => HOME;

// A copy that hands out the module-level internals. `let` bindings need
// accessors, a plain snapshot would freeze their value at export time.
const SRC = path.join(__dirname, '..', 'extension.js');
const COPY = path.join(HOME, 'extension.under-test.js');
fs.writeFileSync(
  COPY,
  fs.readFileSync(SRC, 'utf8') +
    `\nmodule.exports.__test = {
       liveSessionsHere, registryVerdict, workResumed, scanTranscriptLine, scanTranscripts, slugFor, tailOffsets, shortReason,
       getText: () => lastAssistantText, setText: (v) => { lastAssistantText = v; },
       getInterrupt: () => sawInterrupt, setInterrupt: (v) => { sawInterrupt = v; },
       getFailed: () => lastToolFailed, setFailed: (v) => { lastToolFailed = v; },
     };\n`
);

// Minimal `vscode`: nothing under test touches it, but requiring it must work.
const load = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? { workspace: {}, window: {}, commands: {} } : load(req, ...rest));
const {
  liveSessionsHere,
  registryVerdict,
  workResumed,
  scanTranscriptLine,
  scanTranscripts,
  slugFor,
  tailOffsets,
  shortReason,
  getText,
  setText,
  getInterrupt,
  setInterrupt,
  getFailed,
  setFailed,
} = require(COPY).__test;
Module._load = load;

// --- helpers ---------------------------------------------------------------

const userLine = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } });
const interruptLine = (suffix = '') => userLine([{ type: 'text', text: `[Request interrupted by user${suffix}]` }]);
const resultLine = (isError) =>
  userLine([{ type: 'tool_result', tool_use_id: 'x', content: 'out', ...(isError ? { is_error: true } : {}) }]);

function writeSession(pid, cwd, sessionId = `sess-${pid}`) {
  fs.writeFileSync(path.join(SESSIONS, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd }));
}

function clearSessions() {
  for (const n of fs.readdirSync(SESSIONS)) fs.unlinkSync(path.join(SESSIONS, n));
}

// A pid that is certainly gone. 0 and negatives are special to process.kill,
// so take a real child's pid after it exited.
const DEAD_PID = (() => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
})();

// --- transcript line parsing ----------------------------------------------

test('a real interrupt line is detected, both wordings', () => {
  for (const suffix of ['', ' for tool use']) {
    setInterrupt(false);
    scanTranscriptLine(interruptLine(suffix));
    assert.equal(getInterrupt(), true, `wording ${JSON.stringify(suffix)}`);
  }
});

test('the interrupt wording inside tool output does NOT fire', () => {
  // The exact regression this guards: grepping for the phrase writes it into
  // the transcript as tool output, which a substring scan would trip over.
  setInterrupt(false);
  scanTranscriptLine(
    userLine([{ type: 'tool_result', tool_use_id: 'x', content: 'transcript.jsonl:[Request interrupted by user]' }])
  );
  assert.equal(getInterrupt(), false);
});

test('the interrupt wording in an assistant message does NOT fire', () => {
  setInterrupt(false);
  scanTranscriptLine(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Esc writes [Request interrupted by user].' }] },
    })
  );
  assert.equal(getInterrupt(), false);
});

test('a typed prompt that is a plain string is ignored', () => {
  setInterrupt(false);
  scanTranscriptLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'no [Request interrupted by user] here' } }));
  assert.equal(getInterrupt(), false);
});

test('a failed tool call sets the flag, the next successful one clears it', () => {
  setFailed(false);
  scanTranscriptLine(resultLine(true));
  assert.equal(getFailed(), true, 'error seen');
  scanTranscriptLine(resultLine(false));
  assert.equal(getFailed(), false, 'recovered in the same turn');
});

test('only the LAST tool result decides', () => {
  setFailed(false);
  for (const isError of [true, false, true, true, false]) scanTranscriptLine(resultLine(isError));
  assert.equal(getFailed(), false);
});

test('malformed and irrelevant lines never throw', () => {
  for (const line of ['{ not json', '', '{}', JSON.stringify({ type: 'attachment' }), 'tool_result but not json']) {
    assert.doesNotThrow(() => scanTranscriptLine(line));
  }
});

// --- live sessions ---------------------------------------------------------

test('no sessions directory means "can not tell", never "nothing runs"', () => {
  // An older Claude Code without the feature. Clearing markers here would wipe
  // every marker on the machine, so the answer has to be "unknown".
  clearSessions();
  const parked = SESSIONS + '.parked';
  fs.renameSync(SESSIONS, parked);
  try {
    assert.equal(liveSessionsHere('/work/app'), undefined);
  } finally {
    fs.renameSync(parked, SESSIONS);
  }
});

test('a directory without pid files also means "can not tell"', () => {
  clearSessions();
  fs.writeFileSync(path.join(SESSIONS, 'notes.txt'), 'x');
  assert.equal(liveSessionsHere('/any'), undefined);
  fs.unlinkSync(path.join(SESSIONS, 'notes.txt'));
});

test('a dead pid does not count, and an existing registry reports the empty answer', () => {
  clearSessions();
  writeSession(DEAD_PID, '/some/project');
  const r = liveSessionsHere('/some/project');
  assert.deepEqual(r, [], 'registry is authoritative: nothing alive here');
});

test('the own live process counts and is matched by cwd', () => {
  clearSessions();
  writeSession(process.pid, '/work/app');
  assert.equal(liveSessionsHere('/work/app').length, 1);
  assert.equal(liveSessionsHere('/work/other').length, 0);
});

test('a session started in a subfolder still belongs to the project', () => {
  clearSessions();
  writeSession(process.pid, '/work/app/src/deep');
  assert.equal(liveSessionsHere('/work/app').length, 1, 'prefix match');
});

test('a session in a folder below is told apart from one in the folder itself', () => {
  // Alive for the window above it, but it may report to a window of its own.
  clearSessions();
  writeSession(process.pid, '/work/app/src/deep');
  assert.equal(liveSessionsHere('/work/app')[0].below, true);
  clearSessions();
  writeSession(process.pid, '/work/app');
  assert.equal(liveSessionsHere('/work/app')[0].below, undefined, 'the folder itself');
});

test('a project reached through a symlink still matches', () => {
  // VS Code reports the link, a shell-started Claude reports the target (or the
  // other way round). Both sides are resolved, so the two meet.
  const real = path.join(HOME, 'real-project');
  const link = path.join(HOME, 'linked-project');
  fs.mkdirSync(real, { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(real, link);
  clearSessions();
  writeSession(process.pid, link);
  assert.equal(liveSessionsHere(fs.realpathSync(real)).length, 1);
});

test('a sibling folder with the same prefix does NOT match', () => {
  clearSessions();
  writeSession(process.pid, '/work/app-backup');
  assert.equal(liveSessionsHere('/work/app').length, 0, 'separator required');
});

test('terminal sessions are not filtered out by entrypoint', () => {
  clearSessions();
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's', cwd: '/work/app', entrypoint: 'cli' })
  );
  assert.equal(liveSessionsHere('/work/app').length, 1);
});

test('an unreadable or half-written pid file is skipped, not fatal', () => {
  clearSessions();
  fs.writeFileSync(path.join(SESSIONS, `${process.pid}.json`), '{"pid":1,"cwd":');
  assert.deepEqual(liveSessionsHere('/work/app'), []);
});

// --- transcript tailing ----------------------------------------------------

function transcriptFor(cwd, sessionId) {
  const dir = path.join(PROJECTS, slugFor(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sessionId}.jsonl`);
}

test('history is only measured, never replayed', () => {
  const cwd = '/work/hist';
  const file = transcriptFor(cwd, 's1');
  fs.writeFileSync(file, interruptLine() + '\n' + resultLine(true) + '\n');
  tailOffsets.delete(file);
  setInterrupt(false);
  setFailed(false);

  scanTranscripts([{ cwd, sessionId: 's1' }]);
  assert.equal(getInterrupt(), false, 'an old interrupt must not fire now');
  assert.equal(getFailed(), false, 'an old error must not colour this turn');

  fs.appendFileSync(file, interruptLine() + '\n');
  scanTranscripts([{ cwd, sessionId: 's1' }]);
  assert.equal(getInterrupt(), true, 'the newly appended one does fire');
});

test('a half-written line is kept until it is complete', () => {
  const cwd = '/work/partial';
  const file = transcriptFor(cwd, 's2');
  fs.writeFileSync(file, resultLine(false) + '\n');
  tailOffsets.delete(file);
  setInterrupt(false);
  scanTranscripts([{ cwd, sessionId: 's2' }]); // baseline

  const line = interruptLine();
  fs.appendFileSync(file, line.slice(0, 20)); // mid-write, no newline yet
  scanTranscripts([{ cwd, sessionId: 's2' }]);
  assert.equal(getInterrupt(), false, 'nothing is consumed without a newline');

  fs.appendFileSync(file, line.slice(20) + '\n');
  scanTranscripts([{ cwd, sessionId: 's2' }]);
  assert.equal(getInterrupt(), true, 'the completed line is read in full');
});

test('a non-ASCII path resolves to the folder Claude actually uses', () => {
  // Real case from the wild: an Obsidian vault with an emoji in the path.
  assert.equal(slugFor('/Users/x/Brain/💼 Projekte/Steuern'), '-Users-x-Brain----Projekte-Steuern');
});

test('a very long path gets the shortened folder name Claude Code gives it', () => {
  // Past 200 characters Claude Code cuts the name there and appends a hash of
  // the whole path. The rule was checked against a real project with a path
  // of 241 characters (2.1.322); this is the same rule on a neutral path.
  const long =
    '/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/Brain/💼 Projekte/' +
    'Kunde mit einem sehr langen Ordnernamen/'.repeat(4) +
    'Unterlagen 2026';
  assert.equal(
    slugFor(long),
    '-Users-x-Library-Mobile-Documents-iCloud-md-obsidian-Documents-Brain----Projekte-Kunde-mit-einem-sehr-langen-Ordnernamen-Kunde-mit-einem-sehr-langen-Ordnernamen-Kunde-mit-einem-sehr-langen-Ordnernamen-6t5bdi'
  );
  assert.equal(slugFor('/' + 'a'.repeat(199)).length, 200, 'exactly 200 is left alone');
  assert.match(slugFor('/' + 'a'.repeat(200)), /^-a{199}-[0-9a-z]+$/, 'one more is cut');
});

test('a replaced (shorter) transcript re-baselines instead of misreading', () => {
  const cwd = '/work/rotate';
  const file = transcriptFor(cwd, 's3');
  fs.writeFileSync(file, resultLine(false) + '\n' + resultLine(false) + '\n');
  tailOffsets.delete(file);
  scanTranscripts([{ cwd, sessionId: 's3' }]);

  setInterrupt(false);
  fs.writeFileSync(file, interruptLine() + '\n'); // shorter than before
  scanTranscripts([{ cwd, sessionId: 's3' }]);
  assert.equal(getInterrupt(), false, 'baseline again, no garbled offset read');
});

test('a missing transcript is skipped silently', () => {
  assert.doesNotThrow(() => scanTranscripts([{ cwd: '/work/ghost', sessionId: 'nope' }]));
});

// --- a transcript met for the first time ------------------------------------
// Claude Code writes a session's transcript a moment after its first prompt
// (median 146 ms over 472 sessions), so the window meets it during that turn.
// What the turn wrote has to count, what came before it must not. Lines carry
// the time they were written.

const at = (ms) => new Date(ms).toISOString();
const stamped = (line, ms) => JSON.stringify({ ...JSON.parse(line), timestamp: at(ms) });
const assistantLine = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const resetFlags = () => {
  setInterrupt(false);
  setFailed(false);
  setText('');
};

test('the first turn of a new session is read, not just measured', () => {
  const cwd = '/work/fresh';
  const s = [{ cwd, sessionId: 'f1' }];
  const file = transcriptFor(cwd, 'f1');
  resetFlags();
  const prompt = Date.now();
  scanTranscripts(s, prompt); // the prompt is in, the transcript not yet written
  fs.writeFileSync(
    file,
    stamped(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Räum das auf' } }), prompt - 80) + '\n' +
      stamped(resultLine(true), prompt + 900) + '\n' +
      stamped(assistantLine('Welche Datei meinst du?'), prompt + 1500) + '\n'
  );
  scanTranscripts(s, prompt);
  assert.equal(getText(), 'Welche Datei meinst du?', 'the closing words of a turn shorter than the tick');
  assert.equal(getFailed(), true, 'and its failed tool call');

  fs.appendFileSync(file, resultLine(false) + '\n');
  scanTranscripts(s, prompt);
  assert.equal(getFailed(), false, 'from then on it is followed line by line');
});

test('history in a transcript met for the first time stays out', () => {
  // A resumed or forked session opens with the earlier conversation.
  const cwd = '/work/forked';
  const s = [{ cwd, sessionId: 'f2' }];
  const file = transcriptFor(cwd, 'f2');
  const prompt = Date.now();
  const hourAgo = prompt - 3600000;
  fs.writeFileSync(
    file,
    stamped(assistantLine('Soll ich weitermachen?'), hourAgo) + '\n' +
      stamped(resultLine(true), hourAgo + 1000) + '\n' +
      stamped(interruptLine(), hourAgo + 2000) + '\n' +
      interruptLine() + '\n' + // no stamp at all: cannot be told from history
      stamped(assistantLine('Erledigt.'), prompt + 2000) + '\n'
  );
  resetFlags();
  scanTranscripts(s, prompt);
  assert.equal(getInterrupt(), false, 'an Esc from an hour ago is not this turn\'s');
  assert.equal(getFailed(), false, 'nor is its failed tool call');
  assert.equal(getText(), 'Erledigt.', 'only what the turn wrote');
});

test('a transcript met long after the prompt is only measured', () => {
  // Another session that shows up in the project while a long turn runs. Its
  // recent lines are its own business, not the end of the turn on display.
  const cwd = '/work/latecomer';
  const s = [{ cwd, sessionId: 'f3' }];
  const file = transcriptFor(cwd, 'f3');
  const prompt = Date.now() - 60000;
  fs.writeFileSync(file, stamped(interruptLine(), prompt + 30000) + '\n');
  resetFlags();
  scanTranscripts(s, prompt);
  assert.equal(getInterrupt(), false);

  fs.appendFileSync(file, stamped(interruptLine(), Date.now()) + '\n');
  scanTranscripts(s, prompt);
  assert.equal(getInterrupt(), true, 'what it writes from now on is followed');
});

test('a first read takes the end of a long transcript, never all of it', () => {
  const cwd = '/work/long';
  const s = [{ cwd, sessionId: 'f4' }];
  const file = transcriptFor(cwd, 'f4');
  const prompt = Date.now();
  // Half a megabyte of earlier conversation, opening with an Esc of this very
  // minute: it lies before the part that is read, so not even that counts.
  const filler = stamped(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(4000) }] } }), prompt - 7200000);
  fs.writeFileSync(file, stamped(interruptLine(), prompt + 1) + '\n' + (filler + '\n').repeat(130) + stamped(assistantLine('Passt das so?'), prompt + 1200) + '\n');
  assert.ok(fs.statSync(file).size > 500000);
  resetFlags();
  scanTranscripts(s, prompt);
  assert.equal(getText(), 'Passt das so?');
  assert.equal(getInterrupt(), false);
  assert.equal(tailOffsets.get(file), fs.statSync(file).size, 'and the whole file counts as read');
});

test('a last line longer than the first read is skipped, not half-parsed', () => {
  const cwd = '/work/huge';
  const s = [{ cwd, sessionId: 'f5' }];
  const file = transcriptFor(cwd, 'f5');
  const prompt = Date.now();
  // What a screenshot read into the conversation looks like.
  const huge = stamped(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'z'.repeat(400000) }] } }), prompt + 500);
  fs.writeFileSync(file, huge + '\n');
  resetFlags();
  assert.doesNotThrow(() => scanTranscripts(s, prompt));
  assert.equal(getFailed(), false);

  fs.appendFileSync(file, stamped(assistantLine('Fertig.'), prompt + 900) + '\n');
  scanTranscripts(s, prompt);
  assert.equal(getText(), 'Fertig.', 'what follows it is read as usual');
});

process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

// --- API errors ------------------------------------------------------------

// The five wordings actually seen in StopFailure payloads and transcripts,
// with what a banner should say about them.
const API_ERRORS = [
  ["You've hit your monthly spend limit · raise it at claude.ai/settings/usage", "You've hit your monthly spend limit"],
  ['API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.', '529 Overloaded'],
  ['Failed to authenticate: OAuth session expired and could not be refreshed', 'Failed to authenticate: OAuth session expired an…'],
  ['API Error: Connection lost mid-response. The response above may be incomplete.', 'Connection lost mid-response'],
  ['API Error: Server error mid-response. The response above may be incomplete.', 'Server error mid-response'],
];

test('every real API error wording shortens to something readable', () => {
  for (const [raw, expected] of API_ERRORS) {
    assert.equal(shortReason(raw), expected, raw.slice(0, 40));
    assert.ok(shortReason(raw).length <= 49, 'fits a banner subtitle');
  }
});

test('an empty or unknown error message still yields a reason', () => {
  assert.equal(shortReason(''), 'API error');
  assert.equal(shortReason('API Error: '), 'API error');
  assert.equal(shortReason('Something new nobody has seen'), 'Something new nobody has seen');
});

test('an error message is not mistaken for the turn\'s closing words', () => {
  setText('');
  scanTranscriptLine(
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Soll ich das committen?' }] } })
  );
  scanTranscriptLine(
    JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }] } })
  );
  // The question stays the closing text; the StopFailure hook owns the error.
  assert.equal(getText(), 'Soll ich das committen?');
});

// --- the registry's own verdict --------------------------------------------
// Shapes as written by Claude Code 2.1.273: status plus statusUpdatedAt, and
// waitingFor while waiting. T0 is when the marker started.

const T0 = 1_000_000;
const entry = (status, at, extra = {}) => ({ sessionId: 's', cwd: '/work/app', status, statusUpdatedAt: at, ...extra });

test('a session that went idle during the turn ends it', () => {
  assert.deepEqual(registryVerdict([entry('idle', T0 + 5000)], T0), { label: 'idle' });
});

test('an idle from before the prompt proves nothing: the race at turn start', () => {
  // The prompt hook has fired, the CLI has not yet written busy. Clearing here
  // would wipe the marker of every fast-starting turn.
  assert.equal(registryVerdict([entry('idle', T0 - 1)], T0), undefined);
  assert.equal(registryVerdict([entry('idle', 0), entry('idle', T0 - 10)], T0), undefined);
});

test('an idle at exactly the marker time counts as during the turn', () => {
  assert.deepEqual(registryVerdict([entry('idle', T0)], T0), { label: 'idle' });
});

test('a busy session keeps the turn open, whatever the others say', () => {
  assert.equal(registryVerdict([entry('idle', T0 + 5000), entry('busy', T0 + 1)], T0), undefined);
  assert.equal(registryVerdict([entry('busy', T0 + 1), entry('idle', T0 + 5000)], T0), undefined);
});

test('a waiting session asks for you and names the reason', () => {
  assert.deepEqual(registryVerdict([entry('waiting', T0 + 1, { waitingFor: 'permission prompt' })], T0), {
    label: 'waiting',
    reason: 'permission prompt',
  });
  assert.deepEqual(registryVerdict([entry('waiting', T0 + 1)], T0), { label: 'waiting', reason: '' }, 'no reason given');
});

test('a waiting session outranks an idle one', () => {
  assert.equal(
    registryVerdict([entry('idle', T0 + 9000), entry('waiting', T0 + 1, { waitingFor: 'input needed' })], T0).label,
    'waiting'
  );
});

test("a waiting from before the turn is another session's prompt and blocks nothing but the verdict", () => {
  assert.equal(registryVerdict([entry('waiting', T0 - 1), entry('idle', T0 + 5000)], T0), undefined);
});

test('without the status field there is no verdict', () => {
  // An older Claude Code, or a registry entry mid-write.
  assert.equal(registryVerdict([{ sessionId: 's', cwd: '/work/app' }], T0), undefined);
  assert.equal(registryVerdict([], T0), undefined);
});

test('a status this code does not know is treated as busy', () => {
  assert.equal(registryVerdict([entry('shell', T0 + 1)], T0), undefined);
  assert.equal(registryVerdict([entry('paused', T0 + 1)], T0), undefined);
});

test('a missing timestamp counts as old', () => {
  assert.equal(registryVerdict([{ sessionId: 's', cwd: '/w', status: 'idle' }], T0), undefined);
  assert.equal(registryVerdict([{ sessionId: 's', cwd: '/w', status: 'waiting' }], T0), undefined);
});

// --- a ⚠️ whose prompt has been answered ------------------------------------
// Measured against Claude Code 2.1.296: allowing a permission takes the
// session from waiting back to busy and stamps the moment. T0 is when the ⚠️
// showed.

test('a session back at work since the ⚠️ means the prompt was answered', () => {
  assert.equal(workResumed([entry('busy', T0 + 3000)], T0), true);
  assert.equal(workResumed([entry('busy', T0)], T0), true, 'at exactly the marker time counts');
});

test('a session still waiting keeps the ⚠️, whoever else is busy', () => {
  // Two sessions in one project: the working one must not take the other's
  // prompt off the title.
  const asking = entry('waiting', T0 - 100, { waitingFor: 'permission prompt' });
  assert.equal(workResumed([asking, entry('busy', T0 + 3000)], T0), false);
  assert.equal(workResumed([entry('busy', T0 + 3000), asking], T0), false, 'in either order');
  assert.equal(workResumed([asking], T0), false);
});

test('busy from before the ⚠️ proves nothing', () => {
  // A second session that has been working all along.
  assert.equal(workResumed([entry('busy', T0 - 1)], T0), false);
  assert.equal(workResumed([entry('idle', T0 + 5000), entry('busy', T0 - 60000)], T0), false);
});

test('an idle session, an unknown status or no status at all never resume anything', () => {
  assert.equal(workResumed([entry('idle', T0 + 5000)], T0), false, 'a question at the end of a turn waits in an idle session');
  assert.equal(workResumed([entry('shell', T0 + 5000)], T0), false);
  assert.equal(workResumed([{ sessionId: 's', cwd: '/work/app' }], T0), false, 'an older Claude Code');
  assert.equal(workResumed([{ sessionId: 's', cwd: '/w', status: 'busy' }], T0), false, 'busy without a timestamp');
  assert.equal(workResumed([], T0), false);
});
