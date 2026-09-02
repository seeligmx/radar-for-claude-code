// The agent counter (💬 14m 🤖8) reads the subagent transcripts: an agent whose
// transcript ends on its final answer is done, anything else is mid-work, and
// one silent for ten minutes is gone whatever it says. The fixtures mirror the
// line shapes measured in real transcripts.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-agents-'));
const PROJECT = path.join(HOME, 'work', 'app');
fs.mkdirSync(PROJECT, { recursive: true });
os.homedir = () => HOME;

const SRC = path.join(__dirname, '..', 'extension.js');
const COPY = path.join(HOME, 'extension.under-test.js');
fs.writeFileSync(COPY, fs.readFileSync(SRC, 'utf8') + '\nmodule.exports.__test = { countActiveAgents, agentFinished };\n');
const load = Module._load;
Module._load = (req, ...rest) =>
  req === 'vscode'
    ? { workspace: { workspaceFolders: [{ uri: { fsPath: PROJECT }, name: 'app' }] }, window: {}, commands: {} }
    : load(req, ...rest);
const { countActiveAgents, agentFinished } = require(COPY).__test;
Module._load = load;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

// Where Claude Code puts them: the Agent tool's transcripts directly under
// subagents/, a workflow's one level deeper.
const slug = fs.realpathSync(PROJECT).replace(/[^a-zA-Z0-9]/g, '-');
const SUB = path.join(HOME, '.claude', 'projects', slug, 'sess-1', 'subagents');
const WF = path.join(SUB, 'workflows', 'wf_abc');
fs.mkdirSync(WF, { recursive: true });

// The line shapes, as measured: a running agent ends on a tool_use waiting for
// its result or on a result waiting for the model; a finished one on the final
// answer or, for workflow agents, on the StructuredOutput result.
const line = (o) => JSON.stringify(o) + '\n';
const WAITING_FOR_TOOL = line({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }], stop_reason: 'tool_use' },
});
const WAITING_FOR_MODEL = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });
const FINAL_ANSWER = line({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
});
const STRUCTURED_RESULT = line({
  type: 'user',
  toolEndsTurn: true,
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
});

let n = 0;
function agent(dir, ...lines) {
  const file = path.join(dir, `agent-${(n++).toString(16).padStart(17, '0')}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}
function clear() {
  for (const d of [SUB, WF]) {
    for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) fs.unlinkSync(path.join(d, f));
  }
}
const age = (file, minutes) => {
  const t = new Date(Date.now() - minutes * 60000);
  fs.utimesSync(file, t, t);
};
const finished = (file) => agentFinished(file, fs.statSync(file).size);

test('a project without transcripts counts zero', () => {
  clear();
  assert.equal(countActiveAgents(), 0);
});

test('mid-work counts, finished does not, in both transcript folders', () => {
  clear();
  agent(SUB, WAITING_FOR_MODEL, WAITING_FOR_TOOL);
  agent(SUB, WAITING_FOR_TOOL, WAITING_FOR_MODEL, FINAL_ANSWER);
  agent(WF, WAITING_FOR_TOOL, WAITING_FOR_MODEL);
  agent(WF, WAITING_FOR_TOOL, STRUCTURED_RESULT);
  assert.equal(countActiveAgents(), 2);
});

test('the final answer drops the agent right away, no waiting for a window', () => {
  clear();
  const f = agent(SUB, WAITING_FOR_TOOL, WAITING_FOR_MODEL);
  assert.equal(countActiveAgents(), 1);
  fs.appendFileSync(f, FINAL_ANSWER);
  assert.equal(countActiveAgents(), 0, 'seconds after the answer, not minutes');
});

test('an agent resumed with a follow-up counts again', () => {
  clear();
  const f = agent(SUB, WAITING_FOR_TOOL, FINAL_ANSWER);
  assert.equal(countActiveAgents(), 0);
  fs.appendFileSync(f, WAITING_FOR_TOOL);
  assert.equal(countActiveAgents(), 1);
});

test('silent for ten minutes means gone, whatever the transcript says', () => {
  // The fallback for agents killed with Esc or with their session: they never
  // write a final answer, so without this they would count forever.
  clear();
  const f = agent(SUB, WAITING_FOR_TOOL);
  age(f, 9);
  assert.equal(countActiveAgents(), 1, 'nine minutes of thinking is still work');
  age(f, 11);
  assert.equal(countActiveAgents(), 0);
});

test('a half-written last line does not decide', () => {
  clear();
  const f = agent(SUB, WAITING_FOR_TOOL, FINAL_ANSWER.slice(0, 30));
  assert.equal(finished(f), false, 'the last complete line is the tool_use');
  const g = agent(SUB, WAITING_FOR_TOOL, FINAL_ANSWER.trimEnd()); // answer written, newline not yet
  assert.equal(finished(g), false);
  assert.equal(countActiveAgents(), 2);
});

test('blank lines at the end are skipped', () => {
  clear();
  const f = agent(SUB, WAITING_FOR_TOOL, STRUCTURED_RESULT, '\n\n');
  assert.equal(finished(f), true);
  assert.equal(countActiveAgents(), 0);
});

test('a last line longer than the tail read keeps the agent counted', () => {
  // Undecidable answers "not finished"; the mtime fallback lets it go later.
  clear();
  const huge = line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(70 * 1024) }], stop_reason: 'end_turn' },
  });
  agent(SUB, WAITING_FOR_TOOL, huge);
  assert.equal(countActiveAgents(), 1);
});

test('a transcript that is not JSON never throws and stays counted', () => {
  clear();
  const f = agent(SUB, 'garbage\n');
  assert.equal(finished(f), false);
  assert.equal(countActiveAgents(), 1);
});

test('the journal and the meta files next to the transcripts are ignored', () => {
  clear();
  const journal = path.join(WF, 'journal.jsonl');
  const meta = path.join(SUB, 'agent-0000000000000000f.meta.json');
  fs.writeFileSync(journal, WAITING_FOR_TOOL);
  fs.writeFileSync(meta, '{}');
  try {
    assert.equal(countActiveAgents(), 0);
  } finally {
    fs.unlinkSync(journal);
    fs.unlinkSync(meta);
  }
});
