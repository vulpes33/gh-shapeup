import { ShapeUpError } from './domain.mjs';

const issueFields = `id databaseId number title body state stateReason url
  labels(first:20) { nodes { name } }
  parent { number }
  projectItems(first:20) { nodes { id
    project { number owner { ... on User { login } ... on Organization { login } } }
    status: fieldValueByName(name:$status) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    appetite: fieldValueByName(name:$appetite) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    cycle: fieldValueByName(name:$cycle) { ... on ProjectV2ItemFieldIterationValue { title iterationId } }
    hill: fieldValueByName(name:$hill) { ... on ProjectV2ItemFieldNumberValue { number } }
  } }`;

export class Board {
  constructor(api, config) {
    this.api = api;
    this.config = config;
  }
  names() {
    const c = this.config;
    return { status: c.statusField, appetite: c.appetiteField, cycle: c.cycleField, hill: c.hillField };
  }
  async load() {
    const c = this.config;
    const data = await this.api.graphql(`query($owner:String!,$number:Int!) {
      ${c.projectOwnerType}(login:$owner) { projectV2(number:$number) { id
        fields(first:50) { nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
          ... on ProjectV2IterationField { id name dataType configuration {
            iterations { id title startDate } completedIterations { id title startDate } } }
        } }
      } }
    }`, { owner: c.projectOwner, number: c.projectNumber });
    const project = data[c.projectOwnerType]?.projectV2;
    if (!project) throw new ShapeUpError('project', 'The configured GitHub Project was not found.');
    const byName = name => {
      const field = project.fields.nodes.find(node => node.name === name);
      if (!field) throw new ShapeUpError('field', `The project has no field named "${name}".`);
      return field;
    };
    this.projectId = project.id;
    this.fields = { status: byName(c.statusField), appetite: byName(c.appetiteField),
      cycle: byName(c.cycleField), hill: byName(c.hillField) };
    return this;
  }
  option(field, name) {
    const option = this.fields[field].options?.find(item => item.name === name);
    if (!option) throw new ShapeUpError('field', `The field "${this.fields[field].name}" has no option named "${name}".`);
    return option.id;
  }
  // Only a cycle that has not ended can take a bet.
  iteration(title) {
    const config = this.fields.cycle.configuration;
    if (config.completedIterations.some(item => item.title === title)) throw new ShapeUpError('input', `The cycle "${title}" has already ended.`);
    const iteration = config.iterations.find(item => item.title === title);
    if (!iteration) throw new ShapeUpError('input', `The project has no cycle named "${title}".`);
    return iteration.id;
  }
  // Issues are read from the issue side, because the board's item listing can lag behind.
  async issue(number) {
    const [owner, name] = this.api.repository.split('/');
    const data = await this.api.graphql(`query($owner:String!,$name:String!,$number:Int!,$status:String!,$appetite:String!,$cycle:String!,$hill:String!) {
      repository(owner:$owner,name:$name) { issue(number:$number) { ${issueFields} } }
    }`, { owner, name, number, ...this.names() });
    const issue = data.repository.issue;
    if (!issue) throw new ShapeUpError('input', `Issue #${number} does not exist.`);
    return this.shape(issue);
  }
  async issuesWith(labels) {
    const [owner, name] = this.api.repository.split('/');
    const issues = [];
    let cursor = null;
    do {
      const data = await this.api.graphql(`query($owner:String!,$name:String!,$labels:[String!],$cursor:String,$status:String!,$appetite:String!,$cycle:String!,$hill:String!) {
        repository(owner:$owner,name:$name) { issues(first:50,after:$cursor,labels:$labels) {
          nodes { ${issueFields} } pageInfo { hasNextPage endCursor }
        } }
      }`, { owner, name, labels, cursor, ...this.names() });
      const connection = data.repository.issues;
      issues.push(...connection.nodes.map(node => this.shape(node)));
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return issues;
  }
  shape(issue) {
    const c = this.config;
    const item = issue.projectItems.nodes.find(node => node.project.number === c.projectNumber &&
      node.project.owner?.login?.toLowerCase() === c.projectOwner.toLowerCase());
    return { id: issue.id, databaseId: issue.databaseId, number: issue.number, title: issue.title, body: issue.body,
      state: issue.state.toLowerCase(), stateReason: issue.stateReason?.toLowerCase() ?? null, url: issue.url,
      labels: issue.labels.nodes.map(label => label.name), parent: issue.parent?.number ?? null,
      item: item ? { id: item.id, status: item.status?.name ?? null, appetite: item.appetite?.name ?? null,
        cycle: item.cycle ? { title: item.cycle.title, id: item.cycle.iterationId } : null,
        hill: item.hill?.number ?? null } : null };
  }
  async add(contentId) {
    const data = await this.api.graphql(`mutation($project:ID!,$content:ID!) {
      addProjectV2ItemById(input:{projectId:$project,contentId:$content}) { item { id } }
    }`, { project: this.projectId, content: contentId });
    return data.addProjectV2ItemById.item.id;
  }
  async set(itemId, field, value) {
    await this.api.graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}) { projectV2Item { id } }
    }`, { project: this.projectId, item: itemId, field: this.fields[field].id, value });
  }
  setStatus(itemId, key) {
    return this.set(itemId, 'status', { singleSelectOptionId: this.option('status', this.config.statuses[key]) });
  }
  setAppetite(itemId, appetite) {
    const name = this.config.appetites[String(appetite)];
    if (!name) throw new ShapeUpError('input', `--appetite must be one of: ${Object.keys(this.config.appetites).join(', ')}.`);
    return this.set(itemId, 'appetite', { singleSelectOptionId: this.option('appetite', name) });
  }
  setCycle(itemId, iterationId) { return this.set(itemId, 'cycle', { iterationId }); }
  setHill(itemId, position) { return this.set(itemId, 'hill', { number: position }); }
  async clear(itemId, field) {
    await this.api.graphql(`mutation($project:ID!,$item:ID!,$field:ID!) {
      clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}) { projectV2Item { id } }
    }`, { project: this.projectId, item: itemId, field: this.fields[field].id });
  }
}
