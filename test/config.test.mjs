import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaults, defaultKinds, parseConfig } from '../src/config.mjs';

const minimal = { projectOwner: 'octocat', projectOwnerType: 'user', projectNumber: 1 };
const parse = value => parseConfig(JSON.stringify(value));

test('only the project location is required; everything else has a default', () => {
  const config = parse(minimal);
  assert.equal(config.hillField, 'Hill Position');
  assert.equal(config.statuses.doing, 'In progress');
  assert.equal(config.generatedBranch, 'generated/shapeup');
  assert.equal(config.assignee, null);
  assert.deepEqual(config.kinds, defaultKinds);
  assert.deepEqual(parseConfig(readFileSync('examples/shapeup.json', 'utf8')).templateDir, defaults.templateDir);
});
test('partial statuses and kinds keep the defaults they do not name', () => {
  const kind = { template: 'p.md', sections: { goal: 'Goal' }, required: ['goal'] };
  const config = parse({ ...minimal, statuses: { done: 'Finished' }, kinds: { pitch: kind } });
  assert.equal(config.statuses.done, 'Finished');
  assert.equal(config.statuses.shaped, 'Shaped');
  assert.deepEqual(config.kinds.pitch, kind);
  assert.deepEqual(config.kinds.scope, defaultKinds.scope);
});
test('invalid configs are named, not guessed', () => {
  for (const bad of [
    {},
    { ...minimal, projectOwnerType: 'team' },
    { ...minimal, projectNumber: 0 },
    { ...minimal, hillField: '' },
    { ...minimal, generatedBranch: 'main' },
    { ...minimal, appetites: {} },
    { ...minimal, kinds: { pitch: { template: 'p.md', sections: { Goal: 'Goal' } } } },
    { ...minimal, kinds: { pitch: { template: 'p.md', sections: { goal: 'Goal' }, required: ['other'] } } },
  ]) assert.throws(() => parse(bad), { code: 'config' }, JSON.stringify(bad));
  assert.throws(() => parseConfig('{'), { code: 'config' });
});
test('the schema lists every key the loader knows', () => {
  const schema = JSON.parse(readFileSync('config.schema.json', 'utf8'));
  for (const key of [...Object.keys(defaults), 'projectOwner', 'projectOwnerType', 'projectNumber', 'kinds']) {
    assert.ok(key in schema.properties, key);
  }
  assert.deepEqual(Object.keys(schema.properties.statuses.properties), Object.keys(defaults.statuses));
});
