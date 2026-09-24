import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { ShapeUpError } from './domain.mjs';
import { GitHub } from './github.mjs';
import { HillService } from './service.mjs';
import { GeneratedStore } from './store.mjs';

// Action inputs arrive as INPUT_<NAME> with the name upper-cased and hyphens kept.
const input = name => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

async function run() {
  const projectToken = input('project-token');
  if (!projectToken) {
    console.log('::warning::No project token was given, so the hill chart is not drawn.');
    return;
  }
  const config = await loadConfig(input('config') || undefined);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const api = new GitHub({ repository: process.env.GITHUB_REPOSITORY, repositoryToken: input('github-token'), projectToken });
  const service = new HillService(api, new GeneratedStore(api, config.generatedBranch), config);
  if (event.repository?.full_name !== api.repository) throw new ShapeUpError('repository', 'The event comes from a different repository than the run.');
  const name = process.env.GITHUB_EVENT_NAME;
  if (name === 'issue_comment') console.log(`Scope comment: ${await service.comment(event)}`);
  else if (name === 'issues') console.log(`Scope ${event.action}: ${await service.lifecycle(event)}`);
  else if (name === 'workflow_dispatch') console.log(`Rebuilt pitches: ${await service.rebuild(event.inputs?.pitch_number?.trim() ?? '')}`);
  else throw new ShapeUpError('event', `Unsupported event: ${name}`);
}

run().catch(error => {
  // Never log API response bodies, event contents, Authorization headers, or fetch errors.
  console.log(`::error::${error instanceof ShapeUpError ? error.message : 'Internal error in the hill chart Action. Run it again or run a manual rebuild.'}`);
  process.exitCode = 1;
});
