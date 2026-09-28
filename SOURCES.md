# Source snapshot

The first draft copied the three working trees on 2026-09-28. The `domains/` copies were removed in the single-project rewrite. The original repositories were not changed.

| Domain | Source HEAD |
| --- | --- |
| knowledge-graph | `bf9003c0d0a1c1a00aaa7c0da4b123e37e2cbb56` |
| spec-author | `3e881099de598fa7dd2633cc6eae312e71852382` |
| spec-generator | `965e1ba6df6d183f0014ccbe7e15ad7725e2b7d9` |

The working-tree changes are listed in the original repositories' `git status`.

At copy time the dirty files were `knowledgeGraph/package.json`, `knowledgeGraph/src/config/env.ts`, `knowledgeGraph/src/messaging/contract.ts`, `spec-author-agent/src/messaging/contract.ts`, `spec-generation-agent/package.json`, and `spec-generation-agent/src/messaging/contract.ts`.

The graph repository, mappers, ontology, identifiers, merge rules, and their supporting text/hash utilities were later ported directly from the `knowledgeGraph` source snapshot. The framework adapter adds environment loading, `StoryPipeline` persistence, ADO review orchestration, and Playwright result mapping around that graph core.
