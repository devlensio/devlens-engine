Folder Structure on Disk:

```
~/.devlens/
├── index.json                              ← lightweight list of all repos
└── graphs/
    └── {graphId}/                          ← one folder per repo (stable hash)
        ├── meta.json                       ← fingerprint, routes, commit list
        └── commits/
            ├── {commitHash}.json           ← full data for that commit (source of truth)
            ├── {commitHash}.summaries.json ← summarization checkpoint (progress only)
            └── {commitHash}.search.json    ← derived search index, OWNED BY THE OSS CLI (see below)
```

index.json: only what the frontend needs to render a "your analyzed repos" list:

```json
{
  "version": "1.0",
  "graphs": [{
    "graphId": "a3f9b2c1d4e5f6a7",
    "repoPath": "/home/user/AniverseHD",
    "isGithubRepo": false,
    "framework": "nextjs",
    "language": "typescript",
    "latestCommit": "abc12345",
    "latestAnalyzedAt": "2025-01-01T00:00:00Z",
    "commitCount": 3
  }]
}
```

meta.json: what is stable across all commits of the same repo:

```json
{
  "graphId": "a3f9b2c1d4e5f6a7",
  "repoPath": "/home/user/AniverseHD",
  "isGithubRepo": false,
  "fingerprint": { ... },
  "routes": [ ... ],
  "summarizedCommits": [ "abc12345" ],
  "commits": [{
    "commitHash": "abc12345",
    "branch": "main",
    "message": "add payment feature",
    "analyzedAt": "2025-01-01T00:00:00Z",
    "nodeCount": 321,
    "edgeCount": 592,
    "hasGit": true,
    "isSummarized": true,
    "isIndexed": true
  }]
}
```

commits/{hash}.json: everything that changes per commit:

```json
{
  "commitHash": "abc12345",
  "analyzedAt": "2025-01-01T00:00:00Z",
  "nodes": [ ... ],
  "edges": [ ... ],
  "allNodes": [ ... ],
  "allEdges": [ ... ],
  "nodeScores": { ... },
  "stats": { ... ]
}
```

---

## Per-commit state flags

Two booleans on the `CommitSummary` entries in meta.json record derived state
that the engine itself does not produce:

| Flag | Meaning |
| :-- | :-- |
| `isSummarized` | Summaries have been written onto the nodes of that commit |
| `isIndexed` | A derived `.search.json` index exists for that commit (set by the OSS CLI) |

`isSummarized` is also tracked in the `summarizedCommits` array, because
`findLastSummarizedAncestor()` walks that list. `isIndexed` has no such list:
`isCommitIndexed()` is an O(n) lookup over `meta.commits`, which is small enough
to not matter.

### The carry-over rule (important)

`buildCommitSummary()` constructs a fresh `CommitSummary` from the `PipelineResult`
and knows nothing about previous state. `saveGraph()` replaces an existing entry
when the same `commitHash` is analyzed again, so a rebuild would silently reset
the flags. `saveGraph()` therefore carries `isIndexed` over from the entry it
replaces. Any new derived-state flag added to `CommitSummary` must follow the same
rule or it will reset on the next re-analysis of the same commit.

`isSummarized` on the commit entry has no such carry-over and does not need one:
`isCommitSummarized()` reads the `summarizedCommits` array, which `saveGraph()`
leaves untouched, so the summarized state survives a re-analysis. That is exactly
the thing `isIndexed` lacks (it is entry-only), which is why it needs the
explicit carry-over.

---

## Operations and what they touch

```
saveGraph()            → write commits/{hash}.json
                       → update meta.json (add or replace commit entry)
                       → update index.json (update latestCommit, commitCount)
getGraph()             → read meta.json
                       → read commits/{hash}.json (latest if no hash specified)
                       → merge and return PipelineResult
listGraphs()           → read index.json only (never touches graph folders)
deleteGraph()          → delete entire {graphId}/ folder
                       → remove from index.json

markCommitSummarized() → push commitHash into meta.summarizedCommits
                       → set isSummarized = true on the commit entry
isCommitSummarized()   → read meta.summarizedCommits
markCommitIndexed()    → set isIndexed = true on the commit entry (no-op if the
                         entry is already flagged or does not exist)
isCommitIndexed()      → read isIndexed off the commit entry
```

---

## commitHash for repos without git

`getGitInfo()` normally reads `commitHash` from `git rev-parse HEAD`. When there
is no git repository (or no commits yet) it returns a temporary placeholder
`worktree-pending`, which `analyzePipeline()` resolves after extraction, once the
node list exists:

```ts
worktreeCommitHash(nodes) =
  "worktree-" + sha256(sorted `id:codeHash` pairs joined by "|").slice(0, 12)
```

Consequences worth knowing:

- **Content-derived, not time-derived.** The id changes when code changes and
  stays identical when code does not. Previously the fallback was
  `Date.now().toString()`, so every `analyze` run created a brand new commit
  folder: a repo analyzed twenty times left twenty directories under `commits/`,
  none of them reachable, all of them consuming disk.
- **One snapshot per distinct content state.** Re-analyzing an unchanged no-git
  repo rewrites the same `worktree-*` entry in place (the `saveGraph()` replace
  path), so `commits/` does not grow.
- **`hasGit: false` and `message: "worktree snapshot"`** mark these entries, so a
  consumer can tell a snapshot from a real commit. `getGraph()` with no hash
  still resolves to the newest entry by `analyzedAt`.

---

## The derived search index is not the engine's

`commits/{hash}.search.json` lives in the same directory because it is keyed by
commit, but it is written and owned by the DevLens OSS CLI search stack
(`src/search/`), never by this engine. The engine does not read, build, validate,
or delete it.

Its contract with the engine is only the `isIndexed` flag in meta.json: the CLI
builds the index, calls `markCommitIndexed()`, and the flag is carried forward by
`saveGraph()`. Treat the file as disposable: it can be deleted at any time and the
OSS CLI rebuilds it on demand from `{hash}.json`.
