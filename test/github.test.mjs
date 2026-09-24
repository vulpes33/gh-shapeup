import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.mjs';
import { GeneratedStore, generatedReadme } from '../src/store.mjs';

function client(handler) {
  const requests = [];
  const api = new GitHub({ repository: 'owner/repo', repositoryToken: 'repo-secret', projectToken: 'project-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      return handler(requests.at(-1), requests.length);
    },
  });
  return { api, requests };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const config = { projectOwnerType: 'user', projectOwner: 'Owner', projectNumber: 1, hillField: 'Hill Position', pitchLabel: 'pitch' };

test('GraphQL uses the project token and REST the repository token; the body update is a PATCH', async () => {
  const { api, requests } = client(() => response({ data: { user: { projectV2: { field: { dataType: 'NUMBER' } } } } }));
  await api.requireField(config);
  assert.equal(requests[0].headers.Authorization, 'Bearer project-secret');
  await api.updateBody(10, 'body');
  assert.equal(requests[1].headers.Authorization, 'Bearer repo-secret');
  assert.equal(requests[1].method, 'PATCH');
  assert.match(requests[1].url, /\/repos\/owner\/repo\/issues\/10$/);
  assert.deepEqual(requests[1].body, { body: 'body' });
});
test('a missing or non-number Hill Position field is explicit', async () => {
  for (const field of [null, { dataType: 'TEXT' }]) {
    const { api } = client(() => response({ data: { user: { projectV2: { field } } } }));
    await assert.rejects(api.requireField(config), { code: 'field' });
  }
  const { api } = client(() => response({ data: { user: { projectV2: null } } }));
  await assert.rejects(api.requireField(config), { code: 'project' });
});
test('GraphQL error and missing token do not leak response or secrets', async () => {
  const { api } = client(() => response({ errors: [{ message: 'project-secret' }] }));
  await assert.rejects(api.graphql('query {}'), error => error.code === 'graphql' && !error.message.includes('project-secret'));
  api.projectToken = '';
  await assert.rejects(api.graphql('query {}'), { code: 'credential' });
  const denied = client(() => response({ message: 'repo-secret' }, 403));
  await assert.rejects(denied.api.issue(1), error => error.status === 403 && !error.message.includes('repo-secret'));
});
test('REST paginates beyond 100 children; open pitches exclude pull requests', async () => {
  const { api, requests } = client((request, n) => response(n === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i })) : [{ number: 100 }]));
  assert.equal((await api.children(10)).length, 101);
  assert.match(requests[1].url, /page=2/);
  const pitches = client(() => response([{ number: 1 }, { number: 2, pull_request: {} }]));
  assert.deepEqual((await pitches.api.openPitches(config)).map(issue => issue.number), [1]);
  assert.match(pitches.requests[0].url, /issues\?state=open&labels=pitch&per_page=100&page=1$/);
});
test('positions are read per issue and only from the configured board', async () => {
  const item = (number, login, hill) => ({ project: { number, owner: { login } }, hill });
  const { api, requests } = client(() => response({ data: { repository: {
    i11: { projectItems: { nodes: [item(9, 'owner', { number: 99 }), item(1, 'owner', { number: 30 })] } },
    i12: { projectItems: { nodes: [item(1, 'owner', {})] } },
    i13: { projectItems: { nodes: [] } },
  } } }));
  const values = await api.positions([11, 12, 13], config);
  assert.deepEqual([...values], [[11, 30], [12, null], [13, null]]);
  assert.match(requests[0].body.query, /i11: issue\(number:11\)/);
  assert.deepEqual(requests[0].body.variables, { owner: 'owner', name: 'repo', field: 'Hill Position' });
  await assert.rejects(api.positions([0], config), { code: 'input' });
});
test('positions are fetched in chunks of 50', async () => {
  const { api, requests } = client(request => response({ data: { repository: Object.fromEntries(
    [...request.body.query.matchAll(/(i[0-9]+): issue/g)].map(([, alias]) => [alias, { projectItems: { nodes: [] } }])) } }));
  const numbers = Array.from({ length: 120 }, (_, i) => i + 1);
  assert.equal((await api.positions(numbers, config)).size, 120);
  assert.equal(requests.length, 3);
});

function gitFixture() {
  const requests = [];
  let head = null, sequence = 0;
  const commits = new Map(), trees = new Map(), blobs = new Map();
  const api = { async rest(path, options = {}) {
    const { body, method = 'GET' } = options;
    requests.push({ path, method, body });
    if (path.startsWith('/git/ref/')) return head ? { object: { sha: head } } : null;
    if (path.startsWith('/git/commits/') && method === 'GET') return commits.get(path.split('/').at(-1));
    if (path.startsWith('/git/trees/') && method === 'GET') return trees.get(path.split('/').at(-1).split('?')[0]);
    if (path.startsWith('/git/blobs/')) return { content: Buffer.from(blobs.get(path.split('/').at(-1))).toString('base64') };
    if (path === '/git/trees') {
      const old = body.base_tree ? trees.get(body.base_tree).tree : [];
      const map = new Map(old.map(file => [file.path, file]));
      for (const file of body.tree) {
        const sha = `b${++sequence}`;
        blobs.set(sha, file.content);
        map.set(file.path, { path: file.path, sha, mode: file.mode, type: file.type });
      }
      const sha = `t${++sequence}`, tree = { sha, tree: [...map.values()] };
      trees.set(sha, tree); return tree;
    }
    if (path === '/git/commits') {
      const sha = `c${++sequence}`;
      const commit = { sha, tree: { sha: body.tree }, parents: body.parents };
      commits.set(sha, commit); return commit;
    }
    if (path === '/git/refs' && head || path.startsWith('/git/refs/heads/') && commits.get(body.sha).parents[0] !== head) {
      const error = new Error('conflict'); error.status = 422; throw error;
    }
    if (path.startsWith('/git/refs')) { head = body.sha; return {}; }
    throw Error(`Unexpected ${method} ${path}`);
  } };
  return { api, requests, head: () => head };
}
test('Git Data first commit is parentless, later commits append without force', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  const first = await store.write({ 'hills/pitch-1.svg': '<svg>1</svg>' }, 'chore(shapeup): first');
  const second = await store.write({ 'hills/pitch-1.svg': '<svg>2</svg>' }, 'chore(shapeup): second');
  assert.notEqual(first, second);
  assert.equal(await store.write({ 'hills/pitch-1.svg': '<svg>2</svg>' }, 'same'), second);
  const commits = f.requests.filter(request => request.path === '/git/commits');
  assert.deepEqual(commits[0].body.parents, []);
  assert.deepEqual(commits[1].body.parents, [first]);
  assert.equal(commits.length, 2);
  assert.ok(f.requests.filter(request => request.method === 'PATCH').every(request => request.body.force === false));
  const reloaded = new GeneratedStore(f.api, 'generated/shapeup');
  await reloaded.load();
  assert.equal(await reloaded.read('hills/pitch-1.svg'), '<svg>2</svg>');
  assert.equal(await reloaded.read('README.md'), generatedReadme);
});
test('a README from an older wording still marks the branch as generated output', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  await store.write({ 'README.md': '# Shape Up generated data\n\nOlder wording.\n' }, 'older readme');
  await assert.doesNotReject(new GeneratedStore(f.api, 'generated/shapeup').load());
});
test('concurrent orphan creation and stale ref update fail without overwriting winner', async () => {
  const f = gitFixture();
  const a = new GeneratedStore(f.api, 'generated/shapeup'), b = new GeneratedStore(f.api, 'generated/shapeup');
  await a.load(); await b.load();
  await a.write({ 'hills/pitch-1.svg': 'a' }, 'a');
  const first = f.head();
  await assert.rejects(b.write({ 'hills/pitch-2.svg': 'b' }, 'b'), { code: 'conflict' });
  assert.equal(f.head(), first);
  await b.load();
  await a.write({ 'hills/pitch-1.svg': 'a2' }, 'a2');
  const second = f.head();
  await assert.rejects(b.write({ 'hills/pitch-2.svg': 'b2' }, 'b2'), { code: 'conflict' });
  assert.equal(f.head(), second);
  await b.load();
  await b.write({ 'hills/pitch-2.svg': 'b2' }, 'retry');
  assert.equal(await b.read('hills/pitch-1.svg'), 'a2');
});
test('a branch holding any other file is never treated as generated output', async () => {
  const f = gitFixture();
  const store = new GeneratedStore(f.api, 'generated/shapeup');
  await store.load();
  await store.write({ 'history/pitch-1.json': '{}' }, 'foreign');
  await assert.rejects(new GeneratedStore(f.api, 'generated/shapeup').load(), { code: 'branch' });
});
test('only a generated/ branch can hold generated output', () => {
  for (const branch of ['develop', 'main', 'feature/x']) assert.throws(() => new GeneratedStore({}, branch), { code: 'branch' });
  assert.doesNotThrow(() => new GeneratedStore({}, 'generated/charts'));
});
