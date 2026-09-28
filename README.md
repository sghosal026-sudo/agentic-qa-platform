# Agentic QA platform

This repository provides a CLI framework for running an evidence-grounded QA pipeline locally or from GitHub Actions. It integrates Azure DevOps, Neo4j, OpenRouter, GitHub pull-request reviews, and Playwright. It does not run an HTTP service or a separate review application.

The pipeline performs these stages:

1. Discover Stories in an Azure DevOps sprint.
2. Ingest each Story and its `Epic -> Feature -> Story` hierarchy into Neo4j.
3. Extract Story relationships, auto-approve confident ontology-valid relationships, and create Azure DevOps Tasks for ambiguous relationships.
4. Generate test plans, suites, scenarios, and cases after relationship review.
5. Create Azure DevOps Tasks for test-artifact review.
6. Generate Playwright specs after all test artifacts for that Story are approved.
7. Require a GitHub pull-request approval and an approval comment on every generated spec.
8. Run the approved specs and publish the result to Neo4j and the Azure DevOps Story.

Each Story has an independent pipeline record. A pending, rejected, or slow Story does not prevent another approved Story in the same sprint from advancing.

## Knowledge graph behavior

The graph core is ported from the sibling `knowledgeGraph` project. It uses the same node and relationship ontology, semantic relationship rules, provenance model, merge behavior, Neo4j row mapping, full-text index, traversal queries, and atomic relationship-review correction.

- Sprint discovery writes all authoritative `Epic -[:PARENT_OF]-> Feature -[:PARENT_OF]-> Story` relationships before semantic extraction.
- Every discovered Story is linked to `Sprint:<iteration-path>` with `PLANNED_FOR`.
- Source metadata has deterministic, approved provenance.
- LLM entities and relationships retain model evidence and confidence.
- Ontology-valid relationships at or above `RELATION_AUTO_APPROVE_CONFIDENCE` are approved automatically. The default threshold is `0.9`.
- Lower-confidence relationships and ontology-invalid fallbacks require Azure DevOps review.
- An unknown or ontology-invalid relationship is stored as `RELATES_TO` with its suggested type and `needs_review` state.
- Rejected relationships remain in the graph with review history but are excluded from grounded Story context.
- A correction rejects the original fallback relationship and creates the approved typed relationship atomically.
- Approved test designs use the KnowledgeGraph QA relationships such as `CONTAINS`, `COVERS`, `TRACES_TO`, `EXERCISES`, and `EXECUTED_IN`.
- A generated Playwright spec is represented as a `Document` with `documentKind: test-spec`, because `TestSpec` is not a node type in the source ontology.

The `StoryPipeline` records used for CI orchestration remain separate `StoryPipeline` nodes so workflow state does not alter the knowledge ontology.

## Requirements

- Node.js 22 or newer.
- An Azure DevOps project containing Stories assigned to an iteration.
- An Azure DevOps PAT with Work Items read and write access.
- A Neo4j database, such as Neo4j AuraDB.
- An OpenRouter API key.
- A separate Playwright repository with:
  - `package.json` and `package-lock.json`
  - `@playwright/test`
  - a Playwright configuration
  - a Git remote
  - a target application reachable from the machine or GitHub runner
- A GitHub token with access to read pull-request reviews. The automated workflow also needs permission to push branches and create pull requests in the Playwright repository.

## Install

Run all commands from this repository unless a step says otherwise.

```powershell
npm ci
Copy-Item .env.example .env
Copy-Item target.config.example.json target.config.json
```

Do not commit `.env`, access tokens, or database passwords.

## Local environment

Set the following values in `.env`:

```dotenv
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=openai/gpt-oss-120b
RELATION_AUTO_APPROVE_CONFIDENCE=0.9

ADO_ORG_URL=https://dev.azure.com/your-organization
ADO_PROJECT=WMS
ADO_PAT=your-ado-pat
ADO_ITERATION_PATH=WMS\Sprint 1
ADO_REVIEW_PENDING_STATE=New
ADO_REVIEW_COMPLETED_STATE=Closed

GITHUB_TOKEN=your-github-token
```

`ADO_REVIEW_PENDING_STATE` and `ADO_REVIEW_COMPLETED_STATE` must be valid Task states in the Azure DevOps process used by the project.

## Target configuration

Edit `target.config.json`:

```json
{
  "projectDir": "./automation",
  "baseUrl": "http://localhost:3000",
  "safeEnvironments": ["http://localhost:3000"],
  "routes": [
    {
      "method": "GET",
      "path": "/warehouses",
      "responses": [200],
      "requiresAuth": false
    }
  ]
}
```

- `projectDir` points to the checked-out Playwright repository.
- `baseUrl` is supplied to generated tests as `SPECGEN_BASE_URL`.
- `baseUrl` must exactly match an entry in `safeEnvironments`.
- `routes` is the approved API contract used to validate generated requests and expected statuses.
- A case becomes `test.fixme` when its route, status, request body, path values, or authentication binding is not grounded in the approved inputs.

For local generation, clone the Playwright repository into the configured directory. With the example configuration:

```powershell
git clone https://github.com/your-owner/your-playwright-repository.git automation
```

## Recommended: run the sprint pipeline in GitHub Actions

The workflow at `.github/workflows/sprint-story-pipeline.yml` polls the configured sprint every five minutes. It discovers all eligible Stories and processes them with a matrix job. Matrix fail-fast is disabled and concurrency is scoped by ADO Story ID.

### GitHub repository secrets

Open **Settings -> Secrets and variables -> Actions -> Secrets** and create:

| Secret | Purpose |
| --- | --- |
| `ADO_ORG_URL` | Azure DevOps organization URL |
| `ADO_PROJECT` | Azure DevOps project name |
| `ADO_PAT` | PAT used to read Stories and create/read review Tasks and comments |
| `NEO4J_URI` | Neo4j Bolt URI, normally `neo4j+s://...` for Aura |
| `NEO4J_USERNAME` | Neo4j username |
| `NEO4J_PASSWORD` | Neo4j password |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `PLAYWRIGHT_REPO_TOKEN` | Token that can clone the Playwright repository, push branches, create pull requests, and read reviews |

### GitHub repository variables

Open **Settings -> Secrets and variables -> Actions -> Variables** and create:

| Variable | Required | Value |
| --- | --- | --- |
| `ADO_ITERATION_PATH` | Yes | Exact path such as `WMS\Sprint 1` |
| `PLAYWRIGHT_REPOSITORY` | Yes | Playwright repository in `owner/repo` form |
| `TARGET_CONFIG_JSON` | Yes | Complete target configuration JSON; use `"projectDir":"./automation"` |
| `PLAYWRIGHT_BASE_BRANCH` | No | Target PR branch; defaults to `main` |
| `NEO4J_DATABASE` | No | Defaults to `neo4j` |
| `OPENROUTER_MODEL` | No | Defaults to `openai/gpt-oss-120b` |
| `RELATION_AUTO_APPROVE_CONFIDENCE` | No | Confidence from `0` to `1`; defaults to `0.9` |
| `ADO_REVIEW_PENDING_STATE` | No | Defaults to `New`; set it to a valid Task state for the ADO process |
| `ADO_REVIEW_COMPLETED_STATE` | No | Defaults to `Closed`; set it to the Task process's completed state |

Example `TARGET_CONFIG_JSON` value:

```json
{"projectDir":"./automation","baseUrl":"https://qa.example.com","safeEnvironments":["https://qa.example.com"],"routes":[{"method":"GET","path":"/warehouses","responses":[200],"requiresAuth":false}]}
```

### Start the workflow

From GitHub:

1. Open **Actions**.
2. Select **Sprint Story QA Pipeline**.
3. Select **Run workflow**.
4. Optionally enter an iteration path to override `ADO_ITERATION_PATH` for that run.
5. Select **Run workflow**.

With GitHub CLI installed:

```powershell
gh workflow run "Sprint Story QA Pipeline" --ref main -f iteration_path='WMS\Sprint 1'
```

The scheduled trigger runs at minutes 2, 7, 12, and so on. GitHub runs schedules from the workflow on the default branch.

### Relationship review in Azure DevOps

Ingestion creates one child Task per ambiguous relationship and Story. Confident ontology-valid relationships are approved automatically. Copy the current hash from the Task description into a Task comment.

Approve:

```text
Review-Hash: <hash-from-task>
Decision: approve
```

Reject:

```text
Review-Hash: <hash-from-task>
Decision: reject
Reason: <why the relationship is unsupported>
```

Correct:

```text
Review-Hash: <hash-from-task>
Decision: correct
Type: <allowed-relationship-type>
Direction: forward
Reason: <why the correction is required>
```

`Direction` must be `forward` or `reverse`. Move the Task to the configured completed state after adding the comment. When a relationship maps to multiple Stories, every associated Story Task must reach the same decision.

Approved and corrected relationships enter grounded graph retrieval. Rejected relationships remain excluded. Pending or conflicting decisions wait for the next poll.

### Test-artifact review in Azure DevOps

After all relationship decisions resolve, the pipeline generates a Test Plan, Test Suite, Test Scenarios, and Test Cases. It creates a child review Task for every artifact.

Approve:

```text
Review-Hash: <hash-from-task>
Decision: approve
```

Reject:

```text
Review-Hash: <hash-from-task>
Decision: reject
Reason: <why the test artifact is rejected>
```

Move the Task to the configured completed state. All artifacts for that Story must be approved before spec generation. A rejected test artifact blocks only its Story.

### Generated-spec review in GitHub

After every test artifact is approved, the workflow:

1. Writes generated specs under `tests/generated` in the Playwright checkout.
2. Pushes branch `qa/story-<ado-id>`.
3. Creates or updates a pull request.
4. Records the pull-request number and exact commit SHA in Neo4j.

For approval:

1. Add a pull-request review comment on every generated `.spec.ts` file:

   ```text
   Decision: approve
   ```

2. Submit an approving PR review at the same commit SHA.
3. Resolve every changes-requested review.

The author of each file approval comment must have an approved PR review. If the PR head changes, approvals must apply to the new SHA. On the next five-minute poll, the workflow verifies all approvals and executes only the generated specs for that Story.

### Results

After execution, the workflow:

- records approved TestSpec nodes and observed TestRun nodes in Neo4j;
- writes the Playwright JSON report under `runs/<run-id>`;
- posts pass/fail counts and the workflow URL to the Azure DevOps Story;
- uploads the Story run directory as a GitHub Actions artifact for 30 days.

The sprint poll output is uploaded for 14 days.

## Run the sprint pipeline locally

Local sprint processing uses the same graph-backed per-Story state as GitHub Actions.

### 1. Discover Stories

Use the exact Azure DevOps iteration path:

```powershell
npm run qa -- poll-sprint --iteration 'WMS\Sprint 1'
```

Example output:

```json
{
  "iteration": "WMS\\Sprint 1",
  "stories": [
    { "storyId": "FDN-501", "adoId": 1234, "revision": 7 }
  ]
}
```

Discovery retrieves each Story's Feature and Epic parents. A later `advance-story` call writes the hierarchy to Neo4j. Rerun discovery before advancing an existing record when a parent work item changed.

### 2. Advance one Story

Pass the numeric `adoId` returned by discovery:

```powershell
npm run qa -- advance-story --ado-id 1234 --target target.config.json
```

Run the same command again after completing the review work requested by its `action` value:

| Action | Meaning | Next operator action |
| --- | --- | --- |
| `ingestion_review` | Relationship Tasks were created | Complete the relationship reviews in ADO |
| `test_review` | Test artifacts and their review Tasks were created | Approve or reject every artifact in ADO |
| `specs_generated` | Specs were written into `projectDir` | Commit them, push them, open a PR, and record it |
| `spec_review` | No PR is recorded yet | Create and record the PR |
| `waiting` | A required review is still pending | Finish reviews and rerun the command |
| `blocked` | Mapping failed or a test artifact was rejected | Inspect `runs/<run-id>/run.json` and correct the source or review outcome |
| `executed` | Approved specs ran | Inspect the Playwright report and published result |

No relationship extraction means a Story may advance directly to `test_review` on its first call.

### 3. Publish locally generated specs

When `advance-story` returns `specs_generated`, enter the Playwright repository configured by `projectDir`:

```powershell
Set-Location automation
git checkout -b qa/story-1234
git add tests/generated
git commit -m "test: generate specs for FDN-501"
git push --set-upstream origin qa/story-1234
```

Create a pull request in GitHub. Record its number and exact head SHA:

```powershell
$CommitSha = git rev-parse HEAD
Set-Location ..
npm run qa -- record-spec-pr --ado-id 1234 --owner your-owner --repo your-playwright-repository --pr 25 --sha $CommitSha
```

Complete the per-file and PR reviews described above, then advance the Story again:

```powershell
npm run qa -- advance-story --ado-id 1234 --target target.config.json
```

The command checks out the approved SHA in an isolated Git worktree, runs `npm ci`, executes the Story's generated specs, stores the report, updates Neo4j, and comments on the ADO Story.

## Run a directory ingestion manually

This mode ingests exported Story JSON files plus supporting Markdown or text documents. It provides explicit commands for each pipeline stage and is useful outside the sprint workflow.

Input rules:

- JSON files must represent `User Story`, `Product Backlog Item`, or `Story` work items.
- Markdown and text files must name at least one known Story ID.
- An unmapped document stops the run with `mapping_error`.
- This directory command ingests Story content. Live sprint ingestion is the path that resolves the ADO Epic and Feature parent chain.

### 1. Ingest

```powershell
npm run qa -- ingest data/backlog
```

Save the `runId` printed by the command:

```powershell
$RunId = '<run-id>'
```

The command writes state to `runs/<run-id>/run.json` and creates ADO relationship review Tasks.

### 2. Apply relationship reviews

Complete the ADO relationship Tasks using the comment formats above, then run:

```powershell
npm run qa -- review-relationships --run $RunId
```

Exit code `2` means at least one decision is pending or conflicting. Resolve it and rerun the command.

### 3. Generate the test design

```powershell
npm run qa -- design --run $RunId
```

Inspect the generated artifacts in `runs/<run-id>/run.json`.

### 4. Approve every test artifact

Use each artifact ID from the run file:

```powershell
npm run qa -- approve-artifact --run $RunId --id '<artifact-id>' --reviewer 'Reviewer Name'
```

Repeat the command for every Test Plan, Test Suite, Test Scenario, and Test Case. This command records a local approval for directory-mode runs.

### 5. Ingest the approved design

```powershell
npm run qa -- ingest-design --run $RunId
```

The command verifies every artifact approval and content hash before linking the artifacts into Neo4j.

### 6. Generate Playwright specs

```powershell
npm run qa -- generate --run $RunId --target target.config.json
```

Specs are written under `<projectDir>/tests/generated`. TestIR JSON files are written under `runs/<run-id>/test-ir` and remain outside Neo4j.

### 7. Publish and review the specs

Commit the generated files in the Playwright repository, push a branch, and create a pull request. Add `Decision: approve` to each generated spec as a file review comment and submit an approving PR review at the same SHA.

### 8. Execute the approved specs

```powershell
npm run qa -- execute-approved --run $RunId --target target.config.json --owner your-owner --repo your-playwright-repository --pr 25 --sha '<40-character-commit-sha>'
```

Execution refuses an unapproved SHA, an unsafe base URL, a missing per-file approval, unresolved requested changes, or a spec that does not contain its expected Test Case ID.

## Inspect a run

Use this at any local stage:

```powershell
npm run qa -- status --run '<run-id>'
```

For full details, inspect:

```text
runs/<run-id>/run.json
runs/<run-id>/test-ir/*.json
runs/<run-id>/playwright-<execution-id>.json
```

## CLI command reference

All commands use `npm run qa -- <command>`.

| Command | Purpose |
| --- | --- |
| `ingest <directory>` | Start a directory-mode ingestion |
| `review-relationships --run <id>` | Read and apply ADO relationship decisions |
| `design --run <id>` | Generate test-design artifacts |
| `approve-artifact --run <id> --id <artifact-id> --reviewer <name>` | Approve one directory-mode artifact |
| `ingest-design --run <id>` | Verify and ingest all approved artifacts |
| `generate --run <id> --target <file>` | Generate Playwright specs and TestIR |
| `execute-approved --run <id> --target <file> --owner <owner> --repo <repo> --pr <number> --sha <sha>` | Verify PR approvals and execute specs |
| `status --run <id>` | Print a run summary |
| `poll-sprint --iteration <path>` | Discover or refresh sprint Stories and their ADO parents |
| `advance-story --ado-id <id> [--target <file>] [--workflow-url <url>]` | Advance one independent Story to its next eligible stage |
| `record-spec-pr --ado-id <id> --owner <owner> --repo <repo> --pr <number> --sha <sha>` | Attach a generated-spec PR to a Story pipeline |

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Command completed successfully, including a Story that is waiting for review |
| `1` | Configuration/integration failure, or approved Playwright tests reported failures |
| `2` | `review-relationships` found pending or conflicting decisions |

## Validate the framework

Run the complete validation sequence:

```powershell
npm run check
```

It runs:

```text
npm run typecheck
npm test
npm run build
```

Live ADO, Neo4j, OpenRouter, GitHub, and target execution require configured services. Automated tests use sanitized fake integrations.

## Project structure

```text
.github/workflows/       GitHub Actions workflows
data/                    Example backlog and supporting documents
runs/                    Local immutable run artifacts and reports
src/adapters/            ADO, Neo4j, OpenRouter, and GitHub adapters
src/core/                Run-state types and persistence
src/stages/              Ingestion, review, design, generation, and execution stages
src/cli.ts               Supported CLI entry point
src/pipeline.ts          Pipeline coordinator
src/story-pipeline.ts    Independent per-Story orchestration
test/                    Automated tests
```

See [SOURCES.md](SOURCES.md) for the source repository baselines.
