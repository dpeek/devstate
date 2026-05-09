# devstate

`devstate` is an agent-first development loop supervisor. A project defines setup commands, checks, and long-running services in `devstate.json`; the CLI writes a stable Markdown status document for agents to inspect.

## Install

```sh
npm install
npm run build
```

## Commands

```sh
npx devstate
devstate start
devstate check
devstate stop
devstate --watch
devstate --watch --json
```

`npx devstate` launches the interactive setup assistant when `devstate.json` is missing and the terminal is interactive. It detects setup commands, lets you choose checks and services, adds `.devstate` to `.gitignore`, writes `devstate.json`, and can start the dev loop. In non-interactive terminals, use the explicit automation commands below.

`devstate start` runs setup commands, runs checks, starts the service graph, waits for services to become ready, waits for awaitable services to become idle, and prints `.devstate/status.md`.

`devstate check` runs checks and, when a fresh supervisor is running, waits for awaitable services to become idle before printing `.devstate/status.md`. If services are stopped, it prints a stopped summary after checks finish.

`devstate stop` stops the supervisor and services if they are running, writes a stopped status, and prints it. It is idempotent.

`devstate --watch` watches `.devstate/status.md` and prints the latest Markdown whenever it changes. If no status file exists, it tells the user to run `devstate start`.

`devstate --watch --json` watches `.devstate/status.json` and prints the latest JSON document whenever it changes. Add `--wait` to wait for a status file instead of failing when one is missing at startup.

The `.devstate/` directory is generated state and should be ignored by git:

- `.devstate/status.md`
- `.devstate/status.json`
- `.devstate/logs/*.txt`
- `.devstate/control.json`
- `.devstate/control.sock`

## Configuration

Commands are argv arrays, not shell strings:

```json
{
  "$schema": "https://unpkg.com/devstate/schema/v1.json",
  "setup": {
    "install": {
      "cmd": ["npm", "install"]
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
      }
    }
  }
}
```

Service URLs are captured per service with `events.url`. The summary prints `url: ...` only when exactly one service exposes a URL, and `urls: N` when multiple services expose URLs.

Awaitable services declare `events.run`, `events.pass`, and `events.fail`. `devstate check` waits for those services to become idle, where idle means the latest awaitable event is `pass` or `fail`.

## Status

Agents should read `.devstate/status.md` first:

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

Full stdout/stderr for commands and services is preserved in `.devstate/logs/*.txt`. Failed units include a bounded output excerpt in `status.md`.
