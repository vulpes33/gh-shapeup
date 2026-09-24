# github-shapeup

Run [Shape Up](https://basecamp.com/shapeup) on GitHub Issues and Projects.

- A **CLI** that creates and edits pitches, scopes, cooldowns and bugs from your issue templates,
  bets pitches on cycles, moves scopes on the hill with a reason, and audits the board for drift.
- A **GitHub Action** that draws each pitch's hill chart as an SVG and keeps it at the top of the pitch body.

Both read one config file that names your project, its fields and your templates.
The config holds names only: issues, statuses, cycles and hill positions are always read live from GitHub.

## How Shape Up maps onto GitHub

| Shape Up | GitHub |
| --- | --- |
| Pitch | An issue with the `pitch` label |
| Scope | An issue with the `scope` label, linked as a sub-issue of its pitch |
| Betting table | A GitHub Project with a single-select **Status** field (Shaped, Bet, In progress, Done, Dropped) |
| Appetite | A single-select **Appetite** field on the pitch |
| Cycle | An iteration field **Cycle** |
| Hill position | A Number field **Hill Position** (0–100) on each scope; empty counts as 0 |
| Circuit breaker | `shapeup pitch break`: closes the pitch and its open scopes as not planned |
| Cooldown work, bugs | Issues with the `cooldown` and `bug` labels, created from their templates |

Every field, option and label name above is a default and can be renamed in the config.

## Setup

1. **Project.** Create the four fields above on a user or organization project and add the repository's issues to it.
2. **Labels.** Create `pitch`, `scope`, `cooldown` and `bug` (or your own names, set in the config).
3. **Issue templates.** Copy [`examples/ISSUE_TEMPLATE/`](examples/ISSUE_TEMPLATE) to `.github/ISSUE_TEMPLATE/`.
   A template needs front matter with `title` (the prefix, such as `"Pitch: "`) and `labels`,
   one `## ` section per CLI parameter of its kind, and the footnote markers.
   The pitch template also carries the hill markers the Action writes between.
4. **Config.** Copy [`examples/shapeup.json`](examples/shapeup.json) to `.github/shapeup.json` and set your project.
   Its `$schema` line gives editors a description of every key; see [`config.schema.json`](config.schema.json).
5. **Token.** Add a repository secret `SHAPEUP_PROJECT_TOKEN` that can read the project.
   For a user-owned project use a classic token with `read:project` and `repo`.
6. **Workflow.** Copy [`examples/workflows/shapeup-hill.yml`](examples/workflows/shapeup-hill.yml) to `.github/workflows/`.
7. **CLI.** Copy [`examples/shapeup.sh`](examples/shapeup.sh) into the repository.
   It runs the CLI in Docker with your `gh` login, fetching a tagged release with `npx`.

## CLI

```
shapeup pitch new --title T --appetite <key> --problem … --solution … --rabbit-holes … --no-gos …
shapeup pitch edit <number> [--title T] [section parameters] [--appetite <key>]
shapeup pitch bet <number> --cycle "<cycle title>"
shapeup pitch unbet <number>
shapeup pitch break <number>
shapeup pitch done <number>
shapeup scope new --pitch <number> --title T --done …
shapeup scope edit <number> [--title T] [--done …]
shapeup scope start <number>
shapeup scope hill <number> --position 0-100 --reason …
shapeup scope done <number>
shapeup cooldown new --title T --what … [--why …] --done …
shapeup cooldown edit <number> [--title T] [section parameters]
shapeup bug new --title T --symptom … --steps … --expected … [--environment …]
shapeup bug edit <number> [--title T] [section parameters]
shapeup audit [--pitch <number>]
```

- Section parameters are set per kind in the config's `kinds`; the ones above are the defaults.
- Every `new` and `edit` also takes `--from <file>` (Markdown split into `## ` sections) and repeated `--footnote name=description`.
- `scope hill` sets the field first and then posts the reason as a comment, which is what wakes the Action.
- `audit` reports scopes without a pitch, items missing from the board, empty or contradictory statuses, cycles that differ from the pitch, and charts that no longer match the board. It exits with 1 when it finds something.

The CLI reads `GH_TOKEN` and `SHAPEUP_REPOSITORY` from the environment and `.github/shapeup.json` from the working directory
(override the path with `SHAPEUP_CONFIG`).

## Hill chart

The Action keeps this block at the top of each pitch body:

```
<!-- hill:start -->
![Hill chart](https://github.com/<owner>/<repo>/blob/generated/shapeup/hills/pitch-<number>.svg?raw=true&v=<commit>)
<!-- hill:values 11=30 12=60 -->
<!-- hill:end -->
```

- The second line records the values last drawn; the Action redraws a pitch only when its scopes or their positions no longer match it.
- A person's comment on a scope, and a scope opening, closing or reopening, wake the Action.
  Each run aligns the scope's pitch and every open pitch that has scopes, so a run cancelled in the queue loses nothing.
- Scopes closed as not planned leave the chart. Scopes at the same position share one badge, as in `1, 4, 7–9`.
- The SVG is committed to an orphan branch (default `generated/shapeup`, which must start with `generated/`).
  The branch holds only a README and the charts; the Action refuses any other branch and never force-pushes.
- The link is absolute because the Projects side panel resolves relative links against the project page.
  Viewers of a private repository need to be signed in.
- `workflow_dispatch` with an empty `pitch_number` redraws every open pitch that has scopes; with a number it redraws that pitch.

## Action inputs

| Input | Default | Use |
| --- | --- | --- |
| `project-token` | none | Reads the project. Without it the Action only warns. |
| `github-token` | `${{ github.token }}` | Commits the SVG and updates pitch bodies (`contents: write`, `issues: write`). |
| `config` | `.github/shapeup.json` | Path of the config in the checked-out repository. |

## Development

```
node --test "test/*.test.mjs"
node test/render-fixtures.mjs | python3 test/validate-svg.py
```

There are no dependencies. Node 24 or later is required.

## License

[MIT](LICENSE)
