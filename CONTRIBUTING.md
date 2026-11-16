# Contributing to Dak

Thanks for helping. Dak is small on purpose: a CLI, a localhost server, plain TypeScript screens and a thin Mac shell.

## Run it from source

```sh
bun install
bun run test                                              # builds the screens, then runs every test
DAK_DEV=1 DAK_HOME=/tmp/dak-dev bun src/cli.ts serve      # screens reload from dist/ui
bun run build:ui                                          # after changing ui/
sh mac/build.sh --install                                 # the Mac app
```

Use a throwaway `DAK_HOME` while developing, so your real inbox in `~/.dak` is never touched.

## Where things live

| Area | Files |
|---|---|
| Store (SQLite) | `src/store.ts` |
| CLI | `src/cli.ts` |
| HTTP API | `src/server.ts` |
| Agent hooks, waking idle sessions | `src/hook.ts`, `src/wake.ts`, `src/claude-hooks.ts` |
| Screens | `ui/` |
| Mac app | `mac/` |
| What agents read | `docs/agents.md`, `skills/dak/SKILL.md` |

## Pull requests

- One change per pull request, with a test when it changes behaviour. Tests go through the real CLI or HTTP server into a throwaway store (`test/dak.test.ts`).
- Comments say why, not what.
- Keep it local-first: nothing leaves the machine unless the user asks for it.
