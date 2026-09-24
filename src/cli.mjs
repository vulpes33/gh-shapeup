import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audit } from './audit.mjs';
import { Board } from './board.mjs';
import { defaultConfigPath, loadConfig } from './config.mjs';
import { ShapeUpError, requirePosition } from './domain.mjs';
import { GitHub } from './github.mjs';
import { composeBody, editBody, footnoteValues, loadTemplate, sectionValues, titleFor } from './templates.mjs';

export const usage = `Usage: shapeup <kind> <command> [number] [--parameter value ...]

  pitch new --title T --appetite <key> --problem … --solution … --rabbit-holes … --no-gos …
  pitch edit <number> [--title T] [section parameters] [--appetite <key>]
  pitch bet <number> --cycle "<cycle title>"
  pitch unbet <number>
  pitch break <number>
  pitch done <number>
  scope new --pitch <number> --title T --done …
  scope edit <number> [--title T] [--done …]
  scope start <number>
  scope hill <number> --position 0-100 --reason …
  scope done <number>
  cooldown new --title T --what … [--why …] --done …
  cooldown edit <number> [--title T] [section parameters]
  bug new --title T --symptom … --steps … --expected … [--environment …]
  bug edit <number> [--title T] [section parameters]
  audit [--pitch <number>]

Section parameters come from the config's kinds; the ones above are the defaults.
Every new and edit also takes --from <file> (Markdown split into ## sections) and repeated --footnote name=description.`;

export function parseArgs(argv) {
  const [first, second, ...rest] = argv;
  const kind = first;
  const action = first === 'audit' ? null : second;
  const tokens = first === 'audit' ? [second, ...rest].filter(value => value !== undefined) : rest;
  const options = {};
  const footnotes = [];
  let number = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ShapeUpError('input', `--${key} needs a value.`);
      if (key === 'footnote') footnotes.push(value); else options[key] = value;
      i++;
    } else if (number === null && /^[1-9][0-9]*$/.test(token)) number = Number(token);
    else throw new ShapeUpError('input', `Unknown argument: ${token}`);
  }
  return { kind, action, number, options, footnotes };
}

const need = (value, message) => { if (value === null || value === undefined || value === '') throw new ShapeUpError('input', message); return value; };

export class Cli {
  constructor({ api, board, config, readTemplate, readText = path => readFile(path, 'utf8'), out = console.log }) {
    this.api = api;
    this.board = board;
    this.config = config;
    this.readTemplate = readTemplate;
    this.readText = readText;
    this.out = out;
  }
  spec(kind) { return this.config.kinds[kind]; }
  async template(kind) { return loadTemplate(kind, this.spec(kind), await this.readTemplate(this.spec(kind).template)); }
  async values(kind, args) {
    const from = args.options.from === undefined ? undefined : await this.readText(args.options.from);
    return sectionValues(this.spec(kind), args.options, from);
  }
  async create(kind, args) {
    const template = await this.template(kind);
    const body = composeBody(template, await this.values(kind, args), footnoteValues(args.footnotes));
    const issue = await this.api.rest('/issues', { method: 'POST', body: {
      title: titleFor(template, args.options.title), body, labels: template.labels,
      assignees: this.config.assignee ? [this.config.assignee] : [] } });
    return issue;
  }
  async edit(kind, args) {
    const number = need(args.number, 'An issue number is required.');
    const issue = await this.board.issue(number);
    if (!issue.labels.includes(this.config[`${kind}Label`])) throw new ShapeUpError('type', `#${number} is not a ${kind} issue.`);
    const template = await this.template(kind);
    const patch = { body: editBody(issue.body, await this.values(kind, args), footnoteValues(args.footnotes)) };
    if (args.options.title !== undefined) patch.title = titleFor(template, args.options.title);
    await this.api.rest(`/issues/${number}`, { method: 'PATCH', body: patch });
    return issue;
  }
  async boardIssue(number, label) {
    const issue = await this.board.issue(need(number, 'An issue number is required.'));
    if (!issue.labels.includes(this.config[`${label}Label`])) throw new ShapeUpError('type', `#${issue.number} is not a ${label} issue.`);
    if (!issue.item) throw new ShapeUpError('item', `#${issue.number} is not on the board. Check it with audit.`);
    return issue;
  }
  async children(pitch) {
    const children = await this.api.children(pitch.number);
    const scopes = [];
    for (const child of children.filter(c => c.labels.some(label => label.name === this.config.scopeLabel))) {
      scopes.push(await this.board.issue(child.number));
    }
    return scopes;
  }
  close(number, reason) {
    return this.api.rest(`/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: reason } });
  }
  async run(args) {
    const { kind, action } = args;
    const s = this.config.statuses;
    const done = message => { this.out(message); return message; };
    if (kind === 'audit') {
      await this.board.load();
      let issues = [...new Map([...await this.board.issuesWith([this.config.pitchLabel]),
        ...await this.board.issuesWith([this.config.scopeLabel])].map(issue => [issue.number, issue])).values()];
      if (args.options.pitch) {
        const pitch = Number(args.options.pitch);
        issues = issues.filter(issue => issue.number === pitch || issue.parent === pitch);
      }
      const findings = audit(issues, this.config);
      for (const finding of findings) this.out(`#${finding.number} ${finding.rule}`);
      this.out(`Checked ${issues.length} pitches and scopes: ${findings.length ? `${findings.length} finding(s).` : 'no findings.'}`);
      return findings;
    }
    if (!this.spec(kind)) throw new ShapeUpError('input', usage);
    if (action === 'new' && (kind === 'cooldown' || kind === 'bug')) {
      const issue = await this.create(kind, args);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (action === 'edit') {
      const issue = await this.edit(kind, args);
      if (kind === 'pitch' && args.options.appetite !== undefined) {
        await this.board.load();
        if (issue.item?.status !== s.shaped) throw new ShapeUpError('input', `Appetite changes only on a pitch that is ${s.shaped}.`);
        await this.board.setAppetite(issue.item.id, args.options.appetite);
      }
      return done(`#${issue.number} updated`);
    }
    await this.board.load();
    if (kind === 'pitch' && action === 'new') {
      need(args.options.appetite, '--appetite is required.');
      if (!this.config.appetites[String(args.options.appetite)]) {
        throw new ShapeUpError('input', `--appetite must be one of: ${Object.keys(this.config.appetites).join(', ')}.`);
      }
      const issue = await this.create('pitch', args);
      const item = await this.board.add(issue.node_id);
      await this.board.setStatus(item, 'shaped');
      await this.board.setAppetite(item, args.options.appetite);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'pitch' && action === 'bet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const iteration = this.board.iteration(need(args.options.cycle, '--cycle is required.'));
      await this.board.setStatus(pitch.item.id, 'bet');
      await this.board.setCycle(pitch.item.id, iteration);
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open' && c.item)) {
        await this.board.setCycle(scope.item.id, iteration);
        if ([s.shaped, null].includes(scope.item.status)) await this.board.setStatus(scope.item.id, 'bet');
      }
      return done(`#${pitch.number} bet on ${args.options.cycle}`);
    }
    if (kind === 'pitch' && action === 'unbet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      await this.board.setStatus(pitch.item.id, 'shaped');
      await this.board.clear(pitch.item.id, 'cycle');
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open' && c.item)) {
        await this.board.setStatus(scope.item.id, 'shaped');
        await this.board.clear(scope.item.id, 'cycle');
      }
      return done(`#${pitch.number} back to ${s.shaped}`);
    }
    if (kind === 'pitch' && action === 'break') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open')) {
        await this.close(scope.number, 'not_planned');
        if (scope.item) await this.board.setStatus(scope.item.id, 'dropped');
      }
      if (pitch.state === 'open') await this.close(pitch.number, 'not_planned');
      await this.board.setStatus(pitch.item.id, 'dropped');
      return done(`#${pitch.number} closed by the circuit breaker`);
    }
    if (kind === 'pitch' && action === 'done') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const open = (await this.children(pitch)).filter(c => c.state === 'open').map(c => `#${c.number}`);
      if (open.length) throw new ShapeUpError('input', `Scopes are still open: ${open.join(', ')}`);
      if (pitch.state === 'open') await this.close(pitch.number, 'completed');
      await this.board.setStatus(pitch.item.id, 'done');
      return done(`#${pitch.number} done`);
    }
    if (kind === 'scope' && action === 'new') {
      const pitch = await this.boardIssue(need(args.options.pitch, '--pitch is required.') && Number(args.options.pitch), 'pitch');
      if (pitch.state !== 'open') throw new ShapeUpError('input', `#${pitch.number} is a closed pitch.`);
      const issue = await this.create('scope', args);
      await this.api.rest(`/issues/${pitch.number}/sub_issues`, { method: 'POST', body: { sub_issue_id: issue.id } });
      const item = await this.board.add(issue.node_id);
      await this.board.setStatus(item, [s.bet, s.doing].includes(pitch.item.status) ? 'bet' : 'shaped');
      if (pitch.item.cycle) await this.board.setCycle(item, pitch.item.cycle.id);
      await this.board.setHill(item, 0);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'scope' && action === 'start') {
      const scope = await this.boardIssue(args.number, 'scope');
      if (scope.state !== 'open') throw new ShapeUpError('input', `#${scope.number} is closed.`);
      await this.board.setStatus(scope.item.id, 'doing');
      return done(`#${scope.number} ${s.doing}`);
    }
    if (kind === 'scope' && action === 'hill') {
      const scope = await this.boardIssue(args.number, 'scope');
      const raw = need(args.options.position, '--position is required.');
      if (!/^[0-9]{1,3}$/.test(raw)) throw new ShapeUpError('position', 'Hill Position must be an integer from 0 to 100.');
      const position = requirePosition(Number(raw));
      const reason = need(args.options.reason?.trim(), '--reason is required: a hill move always leaves its reason.');
      await this.board.setHill(scope.item.id, position);
      // The reason comment is also the hill chart Action's trigger, so it must follow the field change.
      await this.api.rest(`/issues/${scope.number}/comments`, { method: 'POST', body: { body: reason } });
      return done(`#${scope.number} hill ${scope.item.hill ?? 0} → ${position}`);
    }
    if (kind === 'scope' && action === 'done') {
      const scope = await this.boardIssue(args.number, 'scope');
      if (scope.state === 'open') await this.close(scope.number, 'completed');
      await this.board.setStatus(scope.item.id, 'done');
      return done(`#${scope.number} done`);
    }
    throw new ShapeUpError('input', usage);
  }
}

// Runs in the repository root; the token comes from the environment, never from the command line.
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args.kind || args.kind === 'help') { console.log(usage); return 0; }
  const config = await loadConfig(env.SHAPEUP_CONFIG || defaultConfigPath);
  const token = env.GH_TOKEN;
  const repository = env.SHAPEUP_REPOSITORY;
  if (!token || !repository) throw new ShapeUpError('credential', 'GH_TOKEN and SHAPEUP_REPOSITORY must be set.');
  const api = new GitHub({ repository, repositoryToken: token, projectToken: token });
  const cli = new Cli({ api, board: new Board(api, config), config,
    readTemplate: name => readFile(join(config.templateDir, name), 'utf8') });
  const result = await cli.run(args);
  return Array.isArray(result) && result.length ? 1 : 0;
}
