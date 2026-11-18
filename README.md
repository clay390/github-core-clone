# github-core-clone — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/clay390/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/clay390/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge: one process, no UI, no outside
service, no git binary. It serves from its own in-memory store:

- **git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch, shallow,
  deepen) and receive-pack v0 (push, report-status, side-band-64k) for
  clone / fetch / push, with a full pack reader/writer (plain objects,
  OFS/REF deltas, SHA-1).
- **REST v3 API** under `/api/v3` — repositories, issues, pull requests,
  contents, refs, branches, commits, labels, comments.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issue, pull
  request, node, mutations, cursor pagination, introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (2026-07-28
  revision, `server/discover`, tools/list, tools/call).

## Run

Node 22, standard library only, no dependencies, no install step:

```
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), answers `GET /healthz`,
and long-polls `GET $MAKEFUN_ENV_URL/done` until the trial ends.

For local development, `tests/serve.ts` starts the forge on an ephemeral
loopback port and prints `LISTENING <port>`; authenticate with any
non-empty `Authorization: Bearer <token>` header.

## Layout

- `main.ts` — entrypoint: lifecycle (bind, register, poll done, exit 0).
- `src/app.ts` — HTTP wiring: git / REST / GraphQL / MCP dispatch, auth,
  deterministic `X-GitHub-Request-Id`, JSON error envelope.
- `src/store.ts` — the whole in-memory state: repos, git graph, issues,
  pull requests, labels, comments; deterministic clock and ids.
- `src/gitpack.ts` — git object model, pkt-line framing, pack read/write.
- `src/gitproto.ts` — smart-HTTP advertisements, ls-refs, fetch, push.
- `src/rest.ts` — REST v3 router.
- `src/graphql.ts` — GraphQL parser, executor, introspection.
- `src/mcp.ts` — MCP JSON-RPC 2.0 endpoint.
- `src/scenario.ts` — the fixed scenario identity (viewer `adaiversen`).
- `tests/serve.ts` — local test driver.

## Determinism

All ids and timestamps come from counters and a fixed epoch
(2025-01-01); no wall clock or unseeded randomness in any request path.
Two runs on the same instance leave the same state export byte for byte.

## Results (local, kit suite `sdk/run.ts`)

- Conformance: **120/120** (git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15).
- Perf: **136–143/200** (reference forge: 100/200).
- Entry size: ~187 KB total, largest file ~48 KB (caps: 16 MiB total,
  8 MiB per file).

## Known limitation

A real `git clone` works end to end, and a real `git push` lands the
objects (verified by re-cloning), but the pushing client reports
"the remote end hung up unexpectedly" after the report — a framing
quirk in the push-report's trailing bytes that the kit's own client
does not hit. See `BUILD_LOG.md` for the full investigation.
