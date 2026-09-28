# Agentic QA platform

This is a CLI framework for running an evidence-grounded QA pipeline from CI/CD. It calls OpenRouter, Neo4j, Azure DevOps, GitHub, and Playwright through small internal contracts. It has no HTTP service, review API, RabbitMQ, PostgreSQL, copied domain packages, or separate review page. Run state and reviewer records live in `runs/<run-id>/run.json`.

## Setup

Use Node 22 or newer. Run `npm ci`, copy `.env.example` to `.env`, and set the connection values. Copy `target.config.example.json` to `target.config.json`, then set its project directory, safe base URL, and API routes from an approved target contract. The Playwright project needs its own `package.json`, lockfile, config, and Git remote.

Only ADO Story JSON exports and Markdown/text documents that name a known Story are ingested. A document with no Story mapping pauses the run with a mapping error. Generated specs cover API cases; cases without a grounded route, expected status, or authentication binding become `test.fixme`.

## Run

Use `npm run qa -- <command>` from this folder.

1. `ingest data/backlog` creates a run and one ADO review Task per relationship per Story. Each Task is a child of its Story and copies its Area Path and Iteration Path. Every LLM relationship starts as `needs_review` and stays out of grounded graph retrieval.
2. In each Task, comment with `Review-Hash: <hash>` and `Decision: approve`, `reject`, or `correct`. A correction also needs `Type: <ontology type>` and `Direction: forward` or `reverse`. Rejection and correction need `Reason: <text>`. Move the Task to `ADO_REVIEW_COMPLETED_STATE`, then run `review-relationships --run <id>`. Multi-Story decisions must agree.
3. `design --run <id>` creates a Test Plan, Suite, Scenarios, and Cases for each Story. Inspect `runs/<id>/run.json`, then run `approve-artifact --run <id> --id <artifact-id> --reviewer <name>` for each artifact.
4. `ingest-design --run <id>` ingests all approved artifacts and links them to Stories. It checks that approval hashes still match the content. `generate --run <id> --target target.config.json` writes Playwright specs and TestIR files. TestIR stays outside the graph.
5. Review the specs in a GitHub PR. An approving reviewer adds `Decision: approve` as a review comment on each spec file and approves the PR. `execute-approved --run <id> --target target.config.json --owner <owner> --repo <repo> --pr <number> --sha <full-sha>` verifies the current head, each file comment, and PR approval for that SHA. It executes those specs from an isolated checkout against the safe URL. Approved specs and observed TestRuns are linked to Test Cases and Stories.

`status --run <id>` shows the current stage and any mapping errors.

## Automated sprint workflow

`.github/workflows/sprint-story-pipeline.yml` polls the exact `ADO_ITERATION_PATH` every five minutes. It creates or resumes one graph-backed pipeline per ADO Story revision. During discovery it follows the Story's Azure DevOps parent links and stores the approved `Epic -> Feature -> Story` hierarchy in Neo4j. Each Story has its own GitHub concurrency group, so a pending or rejected Story does not block approved Stories in the same sprint.

For each Story, the workflow waits for all relationship reviews, generates the test design, waits for all test-artifact reviews, generates a Story-specific Playwright PR, waits for the PR and every spec to be approved at the recorded SHA, then executes only those specs. The result is stored in Neo4j, posted to the ADO Story, and uploaded as a GitHub Actions artifact.

Configure these GitHub repository variables:

- `ADO_ITERATION_PATH`: exact sprint iteration path.
- `PLAYWRIGHT_REPOSITORY`: target repository in `owner/repo` form.
- `PLAYWRIGHT_BASE_BRANCH`: target branch; defaults to `main`.
- `TARGET_CONFIG_JSON`: target configuration with `projectDir` set to `./automation`.
- `NEO4J_DATABASE`, `OPENROUTER_MODEL`, and ADO review-state names when their defaults are unsuitable.

Configure `ADO_ORG_URL`, `ADO_PROJECT`, `ADO_PAT`, Neo4j credentials, `OPENROUTER_API_KEY`, and a cross-repository `PLAYWRIGHT_REPO_TOKEN` as GitHub secrets. The target token needs access to create branches and pull requests in the Playwright repository.

## Framework structure

The CLI in `src/cli.ts` is the supported entry point for CI/CD. `src/pipeline.ts` coordinates the stages, `src/contracts.ts` defines the integration boundaries, `src/core/` owns run state, `src/adapters/` contains ADO, Neo4j, and OpenRouter integrations, and `src/stages/` contains the pipeline operations. Integrations are created only by commands that need them, so status checks do not require OpenRouter, ADO, GitHub, or Neo4j credentials.

The relationship review command exits with code `2` while decisions are pending or conflicting. Approved execution exits with code `1` when Playwright reports failures. Unhandled configuration or integration errors also exit with code `1`.

## Checks and scope

Run `npm run check` to typecheck, test, and build in the same order expected by CI. The tests include a sanitized flow with fake ADO, GitHub, graph, and model responses. Live ADO, Neo4j, OpenRouter, GitHub, and target execution need your own configured services. The original repositories are unchanged; see [SOURCES.md](SOURCES.md).
