import { ShapeUpError } from './domain.mjs';

export class GitHub {
  constructor({ repository, repositoryToken, projectToken, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
    this.repository = repository;
    this.repositoryToken = repositoryToken;
    this.projectToken = projectToken;
    this.apiUrl = apiUrl;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body, project = false, missing = false, notFound = false } = {}) {
    const token = project ? this.projectToken : this.repositoryToken;
    if (!token) throw new ShapeUpError('credential', project
      ? 'A token that can read the GitHub Project is required.' : 'A repository token is required.');
    let response;
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ShapeUpError('network', 'Could not reach the GitHub API. Run it again.');
    }
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const error = new ShapeUpError('api', `GitHub API request failed (HTTP ${response.status}). Check token scopes, the configured target and rate limits.`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const result = await response.json();
    // With notFound, a GraphQL NOT_FOUND leaves that part of the data null instead of failing.
    if (result.errors?.length && !(notFound && result.errors.every(error => error.type === 'NOT_FOUND'))) throw new ShapeUpError('graphql', 'A GitHub Project GraphQL request failed. Check that the token can read the project and the repository, and the field names in the config.');
    return result;
  }

  rest(path, options) { return this.request(`/repos/${this.repository}${path}`, options); }
  async graphql(query, variables = {}, { notFound = false } = {}) {
    return (await this.request('/graphql', { method: 'POST', project: true, notFound, body: { query, variables } })).data;
  }
  async pages(path) {
    const values = [];
    for (let page = 1; ; page++) {
      const batch = await this.rest(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }
  issue(number) { return this.rest(`/issues/${number}`); }
  parent(number) { return this.rest(`/issues/${number}/parent`, { missing: true }); }
  children(number) { return this.pages(`/issues/${number}/sub_issues`); }
  async openPitches(config) {
    const issues = await this.pages(`/issues?state=open&labels=${encodeURIComponent(config.pitchLabel)}`);
    return issues.filter(issue => !issue.pull_request);
  }
  updateBody(number, body) {
    return this.rest(`/issues/${number}`, { method: 'PATCH', body: { body } });
  }
  async requireField(config) {
    if (!['user', 'organization'].includes(config.projectOwnerType)) throw new ShapeUpError('config', 'projectOwnerType must be "user" or "organization".');
    const data = await this.graphql(`query($owner:String!,$number:Int!,$field:String!) {
      ${config.projectOwnerType}(login:$owner) { projectV2(number:$number) {
        field(name:$field) { ... on ProjectV2Field { dataType } }
      } }
    }`, { owner: config.projectOwner, number: config.projectNumber, field: config.hillField });
    const project = data[config.projectOwnerType]?.projectV2;
    if (!project) throw new ShapeUpError('project', 'The configured GitHub Project was not found.');
    if (project.field?.dataType !== 'NUMBER') throw new ShapeUpError('field', `The project needs a Number field named "${config.hillField}".`);
  }
  // Read each scope's value from the issue side: the board's item listing can lag behind.
  async positions(numbers, config) {
    const values = new Map();
    const [owner, name] = this.repository.split('/');
    for (let start = 0; start < numbers.length; start += 50) {
      const chunk = numbers.slice(start, start + 50);
      if (chunk.some(number => !Number.isSafeInteger(number) || number < 1)) throw new ShapeUpError('input', 'Issue numbers must be positive integers.');
      const fields = chunk.map(number => `i${number}: issue(number:${number}) { projectItems(first:20) { nodes {
        project { number owner { ... on User { login } ... on Organization { login } } }
        hill: fieldValueByName(name:$field) { ... on ProjectV2ItemFieldNumberValue { number } }
      } } }`).join('\n');
      const data = await this.graphql(`query($owner:String!,$name:String!,$field:String!) {
        repository(owner:$owner,name:$name) { ${fields} }
      }`, { owner, name, field: config.hillField });
      for (const number of chunk) {
        const item = data.repository[`i${number}`]?.projectItems.nodes.find(node =>
          node.project.number === config.projectNumber &&
          node.project.owner?.login?.toLowerCase() === config.projectOwner.toLowerCase());
        values.set(number, item?.hill?.number ?? null);
      }
    }
    return values;
  }
}
