import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cli, credentials, findRoot, parseArgs } from '../src/cli.mjs';
import { audit } from '../src/audit.mjs';
import { parseConfig } from '../src/config.mjs';

const config = parseConfig(readFileSync('examples/shapeup.json', 'utf8'));
const s = config.statuses;
const cycle = { title: 'Cycle 2', id: 'c2' };

function fixture() {
  const calls = [];
  const issues = new Map();
  let next = 30;
  const boardIssue = (number, labels, item, extra = {}) => issues.set(number, { number, title: `T${number}`, body: '',
    state: 'open', stateReason: null, labels, parent: null, item, ...extra });
  boardIssue(10, ['pitch'], { id: 'I10', status: s.bet, appetite: '1 cycle', cycle, hill: null });
  boardIssue(11, ['scope'], { id: 'I11', status: s.bet, cycle, hill: 30 }, { parent: 10 });
  boardIssue(12, ['scope'], { id: 'I12', status: s.doing, cycle, hill: null }, { parent: 10 });
  const api = {
    async rest(path, options = {}) {
      calls.push(['rest', options.method ?? 'GET', path, options.body]);
      if (path === '/issues' && options.method === 'POST') { const number = next++; return { number, id: number * 10, node_id: `N${number}`, html_url: `https://x/${number}` }; }
      return {};
    },
    async children(number) { return [...issues.values()].filter(i => i.parent === number).map(i => ({ number: i.number, labels: i.labels.map(name => ({ name })) })); },
  };
  const board = {
    async load() { calls.push(['load']); },
    async issue(number) { const issue = issues.get(number); if (!issue) throw new Error(`no ${number}`); return structuredClone(issue); },
    async add(node) { calls.push(['add', node]); return `item-${node}`; },
    async setStatus(item, key) { calls.push(['status', item, key]); },
    async setAppetite(item, value) { calls.push(['appetite', item, value]); },
    async setCycle(item, id) { calls.push(['cycle', item, id]); },
    async setHill(item, value) { calls.push(['hill', item, value]); },
    async clear(item, field) { calls.push(['clear', item, field]); },
    iteration(title) { if (title !== 'Cycle 2') throw new Error('bad cycle'); return 'c2'; },
    async issuesWith() { return [...issues.values()]; },
  };
  const out = [];
  const cli = new Cli({ api, board, config, readTemplate: name => readFileSync(`examples/ISSUE_TEMPLATE/${name}`, 'utf8'),
    readText: async () => '', out: line => out.push(line) });
  return { cli, calls, issues, out, run: argv => cli.run(parseArgs(argv)) };
}

test('arguments: kind, action, number, repeated footnotes, missing values', () => {
  assert.deepEqual(parseArgs(['scope', 'hill', '11', '--position', '45', '--reason', 'why', '--footnote', 'a=1', '--footnote', 'b=2']),
    { kind: 'scope', action: 'hill', number: 11, options: { position: '45', reason: 'why' }, footnotes: ['a=1', 'b=2'] });
  assert.deepEqual(parseArgs(['audit', '--pitch', '10']).options, { pitch: '10' });
  assert.throws(() => parseArgs(['pitch', 'new', '--title']), { code: 'input' });
  assert.throws(() => parseArgs(['pitch', 'edit', 'x']), { code: 'input' });
});

test('credentials come from the environment first and from gh otherwise', async () => {
  const asked = [];
  const run = async (file, args) => { asked.push([file, ...args].join(' ')); return args[0] === 'auth' ? 'gho_x\n' : 'o/r\n'; };
  assert.deepEqual(await credentials({ GH_TOKEN: 't', SHAPEUP_REPOSITORY: 'a/b' }, run), { token: 't', repository: 'a/b' });
  assert.deepEqual(asked, []);
  assert.deepEqual(await credentials({ GH_PATH: '/bin/gh' }, run), { token: 'gho_x', repository: 'o/r' });
  assert.deepEqual(asked, ['/bin/gh auth token', '/bin/gh repo view --json nameWithOwner --jq .nameWithOwner']);
  const failing = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'not logged in\n' }); };
  await assert.rejects(credentials({}, failing), { code: 'credential', message: 'No token: run gh auth login, or set GH_TOKEN.\nnot logged in' });
});

test('the root is the nearest directory above that holds the config', async () => {
  const top = await mkdtemp(join(tmpdir(), 'shapeup-'));
  const deep = join(top, 'a', 'b');
  await mkdir(deep, { recursive: true });
  assert.equal(await findRoot(deep), deep);
  await mkdir(join(top, '.github'));
  await writeFile(join(top, '.github', 'shapeup.json'), '{}');
  assert.equal(await findRoot(deep), top);
  assert.equal(await findRoot(top), top);
});
test('pitch new creates the issue from the template and puts it on the board as shaped', async () => {
  const f = fixture();
  await f.run(['pitch', 'new', '--title', 'New pitch', '--appetite', '2', '--problem', 'p', '--solution', 's', '--rabbit-holes', 'r', '--no-gos', 'n']);
  const create = f.calls.find(c => c[0] === 'rest' && c[2] === '/issues');
  assert.equal(create[3].title, 'Pitch: New pitch');
  assert.deepEqual(create[3].labels, ['pitch']);
  assert.deepEqual(create[3].assignees, ['octocat']);
  assert.match(create[3].body, /<!-- hill:start -->/);
  assert.deepEqual(f.calls.filter(c => ['add', 'status', 'appetite'].includes(c[0])),
    [['add', 'N30'], ['status', 'item-N30', 'shaped'], ['appetite', 'item-N30', '2']]);
});
test('without an assignee the issue is created unassigned', async () => {
  const f = fixture();
  f.cli.config = { ...config, assignee: null };
  await f.run(['cooldown', 'new', '--title', 'Tidy', '--what', 'w', '--done', 'd']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues')[3].assignees, []);
});
test('pitch new rejects an unknown appetite before creating anything', async () => {
  const f = fixture();
  await assert.rejects(f.run(['pitch', 'new', '--title', 't', '--appetite', '3']), { code: 'input' });
  assert.ok(!f.calls.some(c => c[2] === '/issues'));
});
test('scope new links the sub-issue and inherits the pitch cycle with Hill Position 0', async () => {
  const f = fixture();
  await f.run(['scope', 'new', '--pitch', '10', '--title', 'New scope', '--done', 'Done']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues/10/sub_issues').slice(1), ['POST', '/issues/10/sub_issues', { sub_issue_id: 300 }]);
  assert.deepEqual(f.calls.filter(c => ['status', 'cycle', 'hill'].includes(c[0])),
    [['status', 'item-N30', 'bet'], ['cycle', 'item-N30', 'c2'], ['hill', 'item-N30', 0]]);
});
test('scope hill sets the field before the reason comment, and needs a reason', async () => {
  const f = fixture();
  await f.run(['scope', 'hill', '11', '--position', '45', '--reason', 'The approach is settled.']);
  const order = f.calls.filter(c => c[0] === 'hill' || c[2] === '/issues/11/comments').map(c => c[0]);
  assert.deepEqual(order, ['hill', 'rest']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues/11/comments')[3], { body: 'The approach is settled.' });
  assert.match(f.out.at(-1), /30 → 45/);
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '50']), { code: 'input' });
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '101', '--reason', 'x']), { code: 'position' });
  await assert.rejects(f.run(['scope', 'hill', '10', '--position', '10', '--reason', 'x']), { code: 'type' });
});
test('pitch break closes open scopes and the pitch as not planned and keeps the cycle', async () => {
  const f = fixture();
  await f.run(['pitch', 'break', '10']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'rest').map(c => [c[2], c[3].state_reason]),
    [['/issues/11', 'not_planned'], ['/issues/12', 'not_planned'], ['/issues/10', 'not_planned']]);
  assert.ok(f.calls.filter(c => c[0] === 'status').every(c => c[2] === 'dropped'));
  assert.ok(!f.calls.some(c => c[0] === 'clear'));
});
test('pitch done refuses while a scope is open', async () => {
  const f = fixture();
  await assert.rejects(f.run(['pitch', 'done', '10']), /#11, #12/);
});
test('pitch bet and unbet move the pitch and its open scopes together', async () => {
  const f = fixture();
  f.issues.get(10).item.status = s.shaped;
  f.issues.get(11).item.status = s.shaped;
  await f.run(['pitch', 'bet', '10', '--cycle', 'Cycle 2']);
  assert.deepEqual(f.calls.filter(c => ['status', 'cycle'].includes(c[0])),
    [['status', 'I10', 'bet'], ['cycle', 'I10', 'c2'], ['cycle', 'I11', 'c2'], ['status', 'I11', 'bet'], ['cycle', 'I12', 'c2']]);
  const g = fixture();
  await g.run(['pitch', 'unbet', '10']);
  assert.deepEqual(g.calls.filter(c => c[0] === 'clear').map(c => c[1]), ['I10', 'I11', 'I12']);
});
test('cooldown and bug are created from their templates without touching the board', async () => {
  const f = fixture();
  await f.run(['bug', 'new', '--title', 'It freezes', '--symptom', 'Frozen', '--steps', '1. Press it', '--expected', 'It moves']);
  const create = f.calls.find(c => c[2] === '/issues');
  assert.equal(create[3].title, 'Bug: It freezes');
  assert.match(create[3].body, /## Steps\n\n1\. Press it/);
  assert.ok(!f.calls.some(c => ['load', 'add', 'status'].includes(c[0])));
});
test('edit refuses the wrong kind', async () => {
  const f = fixture();
  await assert.rejects(f.run(['scope', 'edit', '10', '--done', 'x']), { code: 'type' });
});

const issue = (number, labels, item, extra = {}) => ({ number, labels, state: 'open', stateReason: null, parent: null, body: '', item, ...extra });
test('audit finds drift between issues, the board and the hill chart', () => {
  const item = extra => ({ status: s.bet, appetite: '1 cycle', cycle, hill: null, ...extra });
  const findings = audit([
    issue(1, ['pitch'], item(), { body: '<!-- hill:start -->\n![](x)\n<!-- hill:values 2=0 3=40 -->\n<!-- hill:end -->' }),
    issue(2, ['scope'], item(), { parent: 1 }),
    issue(3, ['scope'], item({ hill: 45 }), { parent: 1 }),
    issue(4, ['scope'], item()),
    issue(5, ['pitch'], null),
    issue(6, ['pitch'], item({ appetite: null, status: null })),
    issue(7, ['scope'], item({ status: s.bet }), { parent: 1, state: 'closed', stateReason: 'completed' }),
    issue(8, ['scope'], item({ cycle: null }), { parent: 1 }),
    issue(9, ['scope'], item({ status: s.done }), { parent: 1 }),
  ], config);
  assert.deepEqual(findings.map(f => `${f.number} ${f.rule}`), [
    '3 is drawn at 40 but the board has 45',
    '4 has no parent pitch',
    '5 is not on the board',
    '6 has no status',
    '6 has no appetite',
    '7 was closed as completed but its status is Bet',
    '7 is drawn at nothing but the board has 0',
    '8 is Bet but has no cycle',
    '8 is in a different cycle from its pitch (none / Cycle 2)',
    '8 is drawn at nothing but the board has 0',
    '9 is open but its status is Done',
    '9 is drawn at nothing but the board has 0',
  ]);
});
