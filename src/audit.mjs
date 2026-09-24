import { drawnValues } from './domain.mjs';

// Pure checks over issues read with Board.issuesWith; each finding names one issue and one rule.
export function audit(issues, config) {
  const findings = [];
  const add = (issue, rule) => findings.push({ number: issue.number, rule });
  const s = config.statuses;
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const kindOf = issue => issue.labels.includes(config.pitchLabel) ? 'pitch'
    : issue.labels.includes(config.scopeLabel) ? 'scope' : null;
  for (const issue of issues) {
    const kind = kindOf(issue);
    if (!kind) continue;
    if (issue.labels.includes(config.pitchLabel) && issue.labels.includes(config.scopeLabel)) add(issue, 'carries both the pitch and the scope label');
    if (kind === 'scope' && issue.parent === null) add(issue, 'has no parent pitch');
    if (kind === 'scope' && issue.parent !== null && byNumber.has(issue.parent) && kindOf(byNumber.get(issue.parent)) !== 'pitch') add(issue, 'has a parent that is not a pitch');
    if (!issue.item) { add(issue, 'is not on the board'); continue; }
    const { status, cycle, appetite } = issue.item;
    if (!status) add(issue, 'has no status');
    if (kind === 'pitch' && !appetite) add(issue, 'has no appetite');
    if ([s.bet, s.doing].includes(status) && !cycle) add(issue, `is ${status} but has no cycle`);
    if (issue.state === 'closed' && issue.stateReason === 'completed' && status !== s.done) add(issue, `was closed as completed but its status is ${status ?? 'empty'}`);
    if (issue.state === 'closed' && issue.stateReason === 'not_planned' && status !== s.dropped) add(issue, `was closed as not planned but its status is ${status ?? 'empty'}`);
    if (issue.state === 'open' && [s.done, s.dropped].includes(status)) add(issue, `is open but its status is ${status}`);
    if (kind === 'scope' && issue.parent !== null && byNumber.get(issue.parent)?.item) {
      const parentCycle = byNumber.get(issue.parent).item.cycle?.title ?? null;
      if ((cycle?.title ?? null) !== parentCycle && issue.state === 'open') add(issue, `is in a different cycle from its pitch (${cycle?.title ?? 'none'} / ${parentCycle ?? 'none'})`);
    }
  }
  for (const pitch of issues.filter(issue => kindOf(issue) === 'pitch')) {
    const drawn = drawnValues(pitch.body);
    if (!drawn) continue;
    const scopes = issues.filter(issue => kindOf(issue) === 'scope' && issue.parent === pitch.number &&
      !(issue.state === 'closed' && issue.stateReason === 'not_planned'));
    for (const scope of scopes) {
      const value = scope.item?.hill ?? 0;
      if (drawn.get(scope.number) !== value) add(scope, `is drawn at ${drawn.get(scope.number) ?? 'nothing'} but the board has ${value}`);
    }
  }
  return findings.sort((a, b) => a.number - b.number);
}
