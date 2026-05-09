# devstate spec

## Goal

`devstate` is an agent-first development loop supervisor.

Tracked config: `devstate.json`.

Generated ignored state:

- `.devstate/status.md`
- `.devstate/status.json`
- `.devstate/logs/*.txt`
- `.devstate/control.json`
- `.devstate/control.sock`

## Runtime

- Node `>=24.12`.
- TypeScript source, compiled JS.
- npm tooling.
- no runtime dependencies.
- macOS/Linux first. Windows best-effort.

## CLI

Public commands:

- `devstate start`
- `devstate check`
- `devstate stop`

Exit codes:

- `0` success/healthy
- `1` runtime/config/health failure
- `2` bad CLI usage

All public command output, including usage and failure cases, is Markdown printed to stdout.

`start`:

- load and validate `devstate.json`.
- if an existing supervisor heartbeat is fresh `<10s`, print status and exit `1`.
- if an existing supervisor heartbeat is stale, remove stale control files/socket and continue.
- run `setup` commands sequentially.
- run `checks` sequentially.
- spawn detached supervisor.
- wait until non-awaitable services are ready and awaitable services are idle.
- print `.devstate/status.md`.
- exit `0` only when checks pass, services are ready, and awaitable services are idle.

`check`:

- load and validate `devstate.json`.
- run `checks` sequentially.
- if a fresh supervisor is running, poll `.devstate/status.json` until awaitable services are idle.
- if services are stopped or no supervisor exists, write and print a stopped summary.
- print `.devstate/status.md`.
- exit `0` when checks pass, non-awaitable services are ready, and awaitable services pass.
- exit `1` for failed checks, failed services, stale supervisor, or wait timeout.

`stop`:

- send JSON line to control socket: `{ "token": "...", "command": "stop" }`.
- supervisor kills services, writes stopped status, and removes the socket.
- if the socket is missing but control heartbeat is fresh `<10s`, fall back to killing tracked process groups.
- idempotent: no supervisor/status still writes stopped status and exits `0`.

## Config

Config file: `devstate.json`.

No shell strings. Commands use argv arrays.

```json
{
  "$schema": "https://unpkg.com/devstate/schema/v1.json",
  "setup": {
    "install": {
      "cmd": ["npm", "install"],
      "cwd": ".",
      "env": {}
    }
  },
  "checks": {
    "check": {
      "cmd": ["npm", "run", "check"]
    }
  },
  "services": {
    "web": {
      "cmd": ["npm", "run", "dev"],
      "events": {
        "url": { "log": "(https?://\\S+)" },
        "ready": { "http": "$url" }
      }
    },
    "test": {
      "cmd": ["npm", "run", "test", "--", "--watch"],
      "events": {
        "ready": { "log": "watching" },
        "run": { "log": "run started" },
        "pass": { "log": "run passed" },
        "fail": { "log": "run failed" }
      },
      "dependsOn": ["web"]
    }
  }
}
```

Validation:

- root keys are `$schema`, `setup`, `checks`, and `services`.
- ids match `^[a-zA-Z][a-zA-Z0-9_-]*$`.
- every `cmd` is a non-empty string array.
- `cwd` is optional and must be relative.
- `env` is an optional string map.
- `dependsOn` service ids must exist.
- dependency graph must have no cycle.
- unsupported fields are invalid: `version`, `primaryService`, `command`, `args`, top-level service `url`, top-level service `ready`, and `awaitable`.

## Events

Compact probes:

```json
{ "log": "READY" }
{ "http": "$url" }
{ "http": "$url", "status": 204 }
```

HTTP status defaults to `200`.

Service event meanings:

- `url`: captures URL metadata from service output. First capture group wins; otherwise the full match wins.
- `ready`: proves the service is usable.
- `run`: marks an awaitable service busy.
- `pass`: marks an awaitable service idle and successful.
- `fail`: marks an awaitable service idle and failed.

A service is awaitable when it declares `events.run`, `events.pass`, and `events.fail`. Services without those events are non-awaitable. Services without `events.ready` become ready immediately after spawn succeeds.

## Status

State vocab:

- aggregate: `stopped`, `starting`, `running`, `fail`, `stale`, `timeout`
- units: `pending`, `starting`, `running`, `pass`, `ready`, `fail`, `stopped`, `stale`, `timeout`

`status.json` contains:

- `version: 1`
- aggregate `state`
- `startedAt`, `updatedAt`, `staleAfterMs`
- public `commands` map for `start`, `check`, and `stop`
- check statuses
- service statuses

Check/service statuses may contain:

- `state`
- `log`
- `command`
- `url`
- `awaitable`
- `outputExcerpt`
- `exitCode`
- `signal`
- `finishedAt`
- `lastRunAt`
- `lastIdleAt`
- `lastEventAt`
- `lastResult`

`status.md`:

````md
# Dev Tool State

## Summary

- checks: ok
- services: running
- url: http://localhost:3000
- updated: 2026-05-08T00:00:00.000Z

## Commands

- `devstate start`: run setup, checks, and services
- `devstate check`: run checks and wait for awaitable services
- `devstate stop`: stop services

## Checks

- 🟢 pass `npm run check` | `.devstate/logs/check-check.txt`

## Services

- 🟢 ready `npm run dev` | http://localhost:3000 | `.devstate/logs/service-web.txt`
````

Stopped status hides `Checks` and `Services` unless a failed unit has an excerpt worth rendering.

Failure excerpts:

- full stdout/stderr logs are preserved in `.devstate/logs/*.txt`.
- failed units store a sanitized excerpt in `status.json`.
- `status.md` renders only failed unit excerpts.
- excerpt limit is the last `80` lines or `12_000` characters, whichever is smaller.
- ANSI sequences are stripped.
- very long individual lines are truncated.

## Supervisor

Start services in dependency order.

No restart.

Service exit:

- before ready -> `fail`
- after ready -> `fail`
- aggregate -> `fail`
- supervisor stays alive until `stop`.

Shutdown:

- kill child process groups with `SIGTERM`.
- wait `1500ms`.
- kill remaining with `SIGKILL`.
- write final stopped status.

No public status pid fields.

Internal `control.json` may contain:

```json
{
  "version": 1,
  "token": "...",
  "supervisorPid": 123,
  "socketPath": ".devstate/control.sock",
  "updatedAt": "...",
  "servicePids": [456]
}
```

## Tests

Use `node:test`, temp dirs, and fixture Node scripts.

Must cover:

- current config sample validates.
- unsupported fields fail validation.
- every public command prints Markdown.
- invalid usage prints Markdown and exits `2`.
- `start` runs setup -> checks -> services.
- repeated `start` with fresh heartbeat exits `1` and does not spawn duplicate services.
- service URL capture works.
- HTTP ready probe works.
- stopped output includes only summary and commands.
- `check` runs checks while stopped.
- `check` waits for an awaitable service to become idle.
- failed checks include bounded excerpts.
- failed services include bounded excerpts.
- crashed service marks fail.
- `stop` stops services.
- double `stop` exits `0`.
