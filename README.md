# Agentic QA platform

This repository provides a CLI framework for running an evidence-grounded QA pipeline locally or from GitHub Actions. It integrates Azure DevOps, Neo4j, PostgreSQL with pgvector, OpenRouter, GitHub pull-request reviews, and Playwright. It does not run an HTTP service or a separate review application.

LLM system, extraction, review, and test-authoring prompts are maintained in `src/prompts/`.

The pipeline performs these stages:

1. Discover Stories in an Azure DevOps sprint.
2. Ingest each Story and its `Epic -> Feature -> Story` hierarchy into Neo4j.
3. Extract Story relationships, auto-approve confident ontology-valid relationships, and create Azure DevOps Tasks for ambiguous relationships.
4. Author a per-Story test plan and applicable functional, integration, E2E, regression, sanity, and smoke suites after relationship review. Generate scenarios before cases and audit their coverage.
5. Create Azure DevOps Tasks for test-artifact review.
6. Generate Playwright specs after all test artifacts for that Story are approved.
7. Require a GitHub pull-request approval and an approval comment on every generated spec.
8. Run the approved specs and publish the result to Neo4j and the Azure DevOps Story.

Each Story has an independent pipeline record. A pending, rejected, or slow Story does not prevent another approved Story in the same sprint from advancing.

## Knowledge graph behavior

The graph core builds on the sibling `knowledgeGraph` project. It keeps its existing node and relationship types, provenance model, merge behavior, Neo4j row mapping, traversal queries, and relationship-review correction. This project extends the ontology for cross-system integration and business behavior.

Named products are `Application` nodes. The ontology also distinguishes generic `Interface` and `Operation` nodes from HTTP `API` and `Endpoint` nodes; `DataStore` from `Database`; and named `DataContract`, `IntegrationFlow`, `WorkflowStep`, and `StateTransition` nodes. `SystemElement` is the fallback for a named technical part that fits none of these types. One `IntegrationFlow` represents one documented hop, with `FLOW_SOURCE`, `FLOW_TARGET`, and optional `USES_CONTRACT` links. A simple state change uses `TRANSITIONS_TO`; a transition with its own trigger or rule can use a `StateTransition` node with `FROM_STATE`, `TO_STATE`, and `CONSTRAINED_BY`. System links include `CALLS`, `PUBLISHES`, `CARRIES`, `SUBSCRIBES_TO`, `READS_FROM`, `WRITES_TO`, `MAPS_TO`, and `TRANSFORMS_TO`. These labels describe the system without requiring vendor-specific types.

- Sprint discovery writes all authoritative `Epic -[:PARENT_OF]-> Feature -[:PARENT_OF]-> Story` relationships before semantic extraction.
- Advancing a Story extracts evidence-backed semantic relationships from its Epic, Feature, and Story descriptions. Each relationship is attributed to its source work item, while ambiguous review Tasks remain under the Story being advanced.
- During ingestion, newly extracted entities and older graph entities explicitly named in the source are candidates for relationships in either direction. Each proposal needs a source quote and an ontology-valid type. New-to-new and older-to-older links require Story review even when the model is confident; new-to-older links follow the normal confidence threshold. An already approved link is not proposed again. This pass does not revisit older sources or infer links from graph proximity alone.
- Test authoring reads the Story and parent source text from PostgreSQL and approved graph relationships, including relevant existing test coverage and links to older Stories.
- Test design records passage IDs and exact source quotes for new scenarios, cases, and expected results. The plan can exclude a candidate suite with a reason; unsupported test oracles leave a design gap for review.
- Integration flows, interfaces, contracts, stores and events can become integration targets; workflow steps and state transitions can become end-to-end targets. Smoke planning stays at the capability, workflow and process level.
- Every discovered Story is linked to `Sprint:<iteration-path>` with `PLANNED_FOR`.
- Source metadata has deterministic, approved provenance.
- LLM entities and relationships retain model evidence and confidence.
- Extraction lists ontology-valid relationship types for each source and target type. Invalid pairs are sent back to the model once for correction; unresolved pairs with specific evidence remain available for human review. General Epic-to-Story claims inferred only from hierarchy are omitted.
- Ontology-valid Story-to-entity and new-to-older relationships at or above `RELATION_AUTO_APPROVE_CONFIDENCE` are approved automatically. The default threshold is `0.9`.
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
- A PostgreSQL database with the `vector` extension available. The configured database user must be able to create the extension and tables on first ingestion.
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

### PostgreSQL and RDS

The PostgreSQL settings in `.env.example` point to the supplied RDS host. Set `POSTGRES_PASSWORD` in your local `.env`. `POSTGRES_HOST` enables document ingestion and is required by CI for test authoring. The app uses `pg` with the RDS CA certificate and checks the server certificate. The installed `aws-sdk` is not needed for password authentication. Set `OPENROUTER_EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` to a matching embedding model and vector size. Changing the size after creating `embeddings` requires a database migration.

Download Amazon's public RDS CA bundle once, at the path given by `POSTGRES_CA_PATH`:

```powershell
Invoke-WebRequest https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -OutFile global-bundle.pem
npm run qa -- postgres-check
```

`postgres-check` only tests the connection. The first `ingest` or `advance-story` creates the `vector` extension and the `documents`, `chunks`, and `embeddings` tables, then writes source text and OpenRouter embeddings. Unchanged documents are skipped on later runs. To inspect retrieved source chunks:

```powershell
npm run qa -- search-documents --query "warehouse creation"
```

The GitHub workflow downloads the same CA bundle and runs on GitHub-hosted `ubuntu-latest`; no EC2 runner is required when RDS is publicly accessible. Configure `POSTGRES_PASSWORD` as a GitHub Actions secret; set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, `OPENROUTER_EMBEDDING_MODEL`, and `EMBEDDING_DIMENSIONS` as repository variables. For the requested access from any IPv4 network, the security group attached to RDS needs an inbound **PostgreSQL / TCP 5432 / `0.0.0.0/0`** rule, saved in AWS. Keep TLS verification and a strong database password enabled. [AWS documents the RDS CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL-certificate-rotation.html) and [pgvector support](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html).

## Local environment

Set the following values in `.env`:

```dotenv
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=neo4j

OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=openai/gpt-oss-120b
TEST_DESIGN_MODEL=openai/gpt-oss-120b
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
| `LANGFUSE_PUBLIC_KEY` | Optional Langfuse tracing public key |
| `LANGFUSE_SECRET_KEY` | Optional Langfuse tracing secret key |
| `POSTGRES_PASSWORD` | RDS PostgreSQL password |
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
| `LANGFUSE_BASE_URL` | No | Langfuse Cloud region or self-hosted URL; uses SDK default if unset |
| `LANGFUSE_TRACING_ENVIRONMENT` | No | Trace environment name, such as `ci` |
| `TEST_DESIGN_MODEL` | No | Separate OpenRouter model for test authoring; defaults to `openai/gpt-oss-120b` |
| `POSTGRES_HOST` | Yes | RDS hostname |
| `POSTGRES_PORT` | No | Defaults to `5432` |
| `POSTGRES_DATABASE` | No | Defaults to `postgres` |
| `POSTGRES_USER` | No | Defaults to `postgres` |
| `OPENROUTER_EMBEDDING_MODEL` | No | Defaults to `openai/text-embedding-3-small` |
| `EMBEDDING_DIMENSIONS` | No | Defaults to `1536` |
| `REVIEWER_OPENROUTER_MODEL` | No | Independent relationship reviewer; defaults to `qwen/qwen3.8-flash` |
| `RELATION_AUTO_APPROVE_CONFIDENCE` | No | Confidence from `0` to `1`; defaults to `0.9` |
| `ADO_REVIEW_PENDING_STATE` | No | Defaults to `New`; set it to a valid Task state for the ADO process |
| `ADO_REVIEW_COMPLETED_STATE` | No | Defaults to `Closed`; set it to the Task process's completed state |

### Langfuse tracing

Set both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` to trace Story advances, sprint polls, stage outcomes, validation retries, and OpenRouter generations. Set `LANGFUSE_BASE_URL` when using a regional Cloud or self-hosted Langfuse instance. CI uses the commit SHA as `LANGFUSE_RELEASE`; locally, set `LANGFUSE_RELEASE` in `.env` if needed. Story traces use `ado-<id>` as the Langfuse session ID. The CLI flushes traces before exiting and prints stage timings to stderr.

Generation traces contain model prompts and responses, including Story content. Configure Langfuse access accordingly. Common credentials and email addresses are masked in trace values; avoid placing secrets in Story text or prompts.

Example `TARGET_CONFIG_JSON` value:

```json
{"projectDir":"./automation","baseUrl":"https://qa.example.com","safeEnvironments":["https://qa.example.com"],"routes":[{"method":"GET","path":"/warehouses","responses":[200],"requiresAuth":false}]}
```

### Start the workflow

From GitHub:

1. Open **Actions**.
2. Select **Sprint Story QA Pipeline**.
3. Select **Run workflow**.
4. Optionally enter an iteration path to override `ADO_ITERATION_PATH` for that run. To retry a Story blocked during graph mapping, enter its ADO ID in `retry_mapping_ado_id`. For a test-design coverage gap, use `retry_design_ado_id`.
5. Select **Run workflow**.

With GitHub CLI installed:

```powershell
gh workflow run "Sprint Story QA Pipeline" --ref main -f iteration_path='WMS\Sprint 1'
```

The scheduled trigger runs at minutes 2, 7, 12, and so on. GitHub runs schedules from the workflow on the default branch.

### Relationship review in Azure DevOps

Ingestion creates one child Task per ambiguous relationship and Story. Confident ontology-valid relationships are approved automatically. Copy the current hash from the Task description into a Task comment.

The Story pipeline also asks an independent OpenRouter model to review each pending relationship Task. It posts an `AI relationship recommendation` comment with a suggested approval, correction, rejection, or uncertainty and its supporting quote. The recommendation does not complete the Task or count as a decision. The next poll retries recommendations that are missing for the current proposal hash without posting duplicates. A person must still add the formal decision comment below and complete the Task.

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

If a completed Task says `Decision: correct` but gives the relationship's existing type and `Direction: forward`, the pipeline applies it as an approval because the proposed relationship does not change.

Approved and corrected relationships enter grounded graph retrieval. Rejected relationships remain excluded. Pending or conflicting decisions wait for the next poll.
If a review Task is deleted, the next Story advance creates a replacement Task and stores its new ID. Its review must be submitted on the replacement Task.

### Test authoring and coverage

After relationship review, the author reads the Story, Feature, and Epic source text from PostgreSQL and approved Neo4j context. It evaluates functional, integration, E2E, regression, sanity, and smoke targets; types with no supported target are marked inapplicable. It writes a plan, reuses matching approved graph scenarios and cases, creates missing scenarios before cases, validates model references and evidence, and audits acceptance-criterion and target coverage. The OpenRouter model is configured by `TEST_DESIGN_MODEL`.

Each attempt writes `runs/<run-id>/test-design/attempt-<n>/design.json`, `design.xlsx`, and `coverage.json`. The workbook has a plan sheet, a Story sheet, scenarios, one sheet per applicable test type, and coverage. CI uploads the run directory as an artifact.

For new Story runs, coverage gaps and failed model batches appear in the single Story test review Task. A human can confirm a manual fix or supply a grounded correction for an affected graph case. Existing per-artifact runs retain their earlier behavior: incomplete coverage blocks before test review. To retry a legacy blocked design after correcting the source or model issue:

```powershell
npm run qa -- retry-design --ado-id 1234
npm run qa -- advance-story --ado-id 1234 --target target.config.json
```

In GitHub Actions, run the workflow manually with `retry_design_ado_id=1234`. Other Stories continue through their own approval stages.

If graph mapping fails because the entity-connection model output has the wrong shape, the pipeline asks the model to correct the schema twice. The run records the field errors for each failed attempt. After fixing a persistent mapping issue, start a fresh attempt for only that Story:

```powershell
npm run qa -- retry-mapping --ado-id 1234
npm run qa -- advance-story --ado-id 1234 --target target.config.json
```

The failed run remains in `runs/<run-id>` for inspection. In GitHub Actions, set `retry_mapping_ado_id=1234` on a manual workflow run.

### Test-artifact review in Azure DevOps

New runs create **one child test review Task per affected Story and run**. It lists every new or revised Plan, Suite, Scenario, Case, and gap with item ID, hash, confidence, evidence, review reason, and before/after summary. The full JSON and XLSX reports are in `runs/<run-id>/test-review.json` and `test-review.xlsx`; CI uploads that directory. Reused graph scenarios and cases remain references. A case owned by another Story is reviewed in that Story's own Task. Older runs keep their existing per-artifact Tasks and decisions.

Copy the item ID and its current hash into a comment on the Story Task:

```text
Item-ID: TestCase:example
Review-Hash: <current-item-hash>
Decision: approve
```

For rejection, include `Reason:`. For correction, include both `Reason:` and `Correction:` with the requested plain-language change. The model turns a correction into a patch; invalid, unsupported, or stale patches stay pending with an error on the item. A gap approval confirms a manual-fix item and marks its affected case outdated. Decisions are independent, so an approved case can move to spec generation while another item waits. The Task closes automatically after every item has a terminal decision; do not close it to approve. AI-labelled comments and stale hashes do not count. Deleted Tasks are recreated on the next poll.

When a Story, Feature, or Epic source changes, the pipeline removes old source provenance before remapping. It searches all graph-managed case steps and explicit dependencies, asks the model to confirm inferred impact, and proposes evidence-backed changes while preserving the prior approved case and spec SHA. Tests in every suite can be affected; SIT is treated as integration. A case with no safe update becomes a gap. Handwritten Playwright files without graph cases are outside this flow.

For legacy per-artifact runs, the original comments still apply:

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

For those legacy Tasks, move each Task to the configured completed state. All artifacts for that Story must be approved before spec generation. A rejected legacy artifact blocks only its Story. Deleted legacy Tasks are recreated on the next Story advance.

### Generated-spec review in GitHub

After approved cases are ready, the workflow:

1. Writes generated specs under `tests/generated` in the Playwright checkout.
2. Pushes an immutable review branch `qa/story-<ado-id>/run-<run-id>/batch-<n>`.
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

### Reset all pipeline state

```powershell
npm run qa "--" reset --all
```

This moves matching pipeline review Tasks in the configured ADO project to its recycle bin, then deletes every node and relationship in the configured Neo4j database, including Story pipeline records. Tasks must have a pipeline review tag and a generated title containing a run ID. If ADO deletion fails, the graph is retained so the command can be retried. Local `runs/` files and generated Playwright pull requests remain; a new sprint poll and Story advance create new runs.

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
| `test_review` | A Story test review Task was created for a new run, or legacy artifact Tasks were created | Review each listed item in ADO |
| `specs_generated` | Specs were written into `projectDir` | Commit them, push them, open a PR, and record it |
| `spec_review` | No PR is recorded yet | Create and record the PR |
| `waiting` | A required review is still pending | Finish reviews and rerun the command |
| `blocked` | Mapping failed, test-design coverage has gaps, or an artifact was rejected | Inspect `runs/<run-id>/run.json` and the coverage report; use `retry-mapping` for a mapping error or `retry-design` for a design gap |
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

Inspect the generated artifacts in `runs/<run-id>/run.json` and the JSON, XLSX, and coverage report under `runs/<run-id>/test-design/attempt-<n>/`. Exit code `2` means coverage gaps blocked the design.

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
| `retry-design --ado-id <id>` | Reopen a Story blocked by test-design coverage for one explicit retry |
| `retry-mapping --ado-id <id>` | Start a new mapping run for a Story blocked by a mapping error |
| `approve-artifact --run <id> --id <artifact-id> --reviewer <name>` | Approve one directory-mode artifact |
| `ingest-design --run <id>` | Verify and ingest all approved artifacts |
| `generate --run <id> --target <file>` | Generate Playwright specs and TestIR |
| `execute-approved --run <id> --target <file> --owner <owner> --repo <repo> --pr <number> --sha <sha>` | Verify PR approvals and execute specs |
| `status --run <id>` | Print a run summary |
| `poll-sprint --iteration <path>` | Discover or refresh sprint Stories and their ADO parents |
| `reset --all` | Recycle pipeline ADO review Tasks and clear the configured Neo4j database |
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
