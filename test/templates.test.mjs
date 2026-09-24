import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultKinds } from '../src/config.mjs';
import { composeBody, editBody, footnoteValues, loadTemplate, parseBody, sectionValues, titleFor } from '../src/templates.mjs';
import { drawnValues } from '../src/domain.mjs';

const read = name => readFileSync(`examples/ISSUE_TEMPLATE/${name}`, 'utf8');
const load = kind => loadTemplate(kind, defaultKinds[kind], read(defaultKinds[kind].template));

for (const kind of Object.keys(defaultKinds)) {
  test(`the example ${kind} template has every section, the prefix and the footnote block`, () => {
    const template = load(kind);
    assert.match(template.prefix, /^[A-Z][a-z]+: $/);
    assert.equal(template.labels.length, 1);
    assert.ok(template.footnotes instanceof Map);
  });
}
test('a new pitch keeps the guidance, the hill markers and the footnote block', () => {
  const template = load('pitch');
  const values = sectionValues(defaultKinds.pitch, { problem: 'The problem', solution: 'The solution', 'rabbit-holes': 'Holes', 'no-gos': 'Out' });
  const body = composeBody(template, values, footnoteValues(['cli=#3']));
  assert.match(body, /^<!-- Keep issue/);
  assert.match(body, /\n<!-- hill:start -->\n<!-- !\[Hill chart\]/);
  assert.match(body, /## Problem\n\nThe problem\n\n## Solution\n\nThe solution\n\n## Rabbit holes\n\nHoles\n\n## No-gos\n\nOut\n\n/);
  assert.match(body, /<!-- footnotes:start -->\n<!-- \[\^name\]: description -->\n\[\^cli\]: #3\n<!-- footnotes:end -->\n$/);
  assert.equal(drawnValues(body), null);
  assert.doesNotMatch(body, /Who is stuck/);
});
test('a missing required section is named', () => {
  assert.throws(() => composeBody(load('pitch'), sectionValues(defaultKinds.pitch, { problem: 'p' }), new Map()),
    /--solution, --rabbit-holes, --no-gos/);
});
test('an optional section left out keeps its guidance comment', () => {
  const body = composeBody(load('cooldown'), sectionValues(defaultKinds.cooldown, { what: 'What to do', done: 'Done' }), new Map());
  assert.match(body, /## Why\n\n## Done means\n\nDone/);
});
test('--from supplies sections by heading and parameters win', () => {
  const values = sectionValues(defaultKinds.scope, { done: 'parameter' }, '## Done means\n\nfile\n');
  assert.equal(values.get('Done means'), 'parameter');
  assert.equal(sectionValues(defaultKinds.scope, {}, '## Done means\n\nfile\n').get('Done means'), 'file');
});
test('headings come from the kind spec, so any language works', () => {
  const spec = { template: 'x.md', sections: { goal: 'Ziel' }, required: ['goal'] };
  const template = loadTemplate('custom', spec, '---\ntitle: "Custom: "\nlabels: ["custom"]\n---\n\n## Ziel\n\n<!-- footnotes:start -->\n<!-- footnotes:end -->\n');
  assert.match(composeBody(template, sectionValues(spec, { goal: 'Erledigt' }), new Map()), /## Ziel\n\nErledigt/);
  assert.throws(() => loadTemplate('custom', spec, '---\ntitle: "C: "\n---\n\n## Other\n'), { code: 'template' });
});
test('editing replaces named sections, merges footnotes and keeps the rest', () => {
  const body = '<!-- guidance -->\n\n<!-- hill:start -->\n![Hill chart](x)\n<!-- hill:values 1=5 -->\n<!-- hill:end -->\n\n## Problem\n\nOld problem.[^a]\n\n## Solution\n\nSolution\n\n<!-- footnotes:start -->\n<!-- [^name]: description -->\n[^a]: #1\n<!-- footnotes:end -->\n';
  const edited = editBody(body, new Map([['Problem', 'New problem.[^a][^b]']]), footnoteValues(['b=#2', 'a=#3']));
  assert.match(edited, /## Problem\n\nNew problem\.\[\^a\]\[\^b\]\n\n## Solution\n\nSolution/);
  assert.match(edited, /\[\^a\]: #3\n\[\^b\]: #2\n<!-- footnotes:end -->/);
  assert.deepEqual([...drawnValues(edited)], [[1, 5]]);
});
test('an old body without the footnote block gains one', () => {
  const edited = editBody('## Done means\n\nDone.\n', new Map(), new Map());
  assert.match(edited, /## Done means\n\nDone\.\n\n<!-- footnotes:start -->\n<!-- \[\^name\]: description -->\n<!-- footnotes:end -->\n$/);
  assert.equal(parseBody(edited).sections.length, 1);
});
test('titles get the template prefix once; footnotes need name=description', () => {
  const template = load('bug');
  assert.equal(titleFor(template, 'The button freezes'), 'Bug: The button freezes');
  assert.equal(titleFor(template, 'Bug: already prefixed'), 'Bug: already prefixed');
  assert.throws(() => titleFor(template, ' '), { code: 'input' });
  assert.throws(() => footnoteValues(['no-equals']), { code: 'input' });
});
