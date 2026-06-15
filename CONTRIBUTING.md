# Contributing

Thanks for your interest in the project. Issues and pull requests are welcome.

## Reporting bugs

Open an issue with:

- what you watched and in which player/server (Plex, VLC, ...);
- what you expected and what happened instead;
- relevant log lines. Set `"log_level": "debug"` in `data/config.json` (or in
  the raw config editor in the UI) and grab the output around the problem.

## Development setup

Requires Node.js 24+ and [pnpm](https://pnpm.io/) 11+ (`corepack enable`).

```bash
pnpm install
pnpm dev:all         # backend + Vue UI dev server
```

Other useful commands:

```bash
pnpm dev             # headless server only, with auto-reload
pnpm test            # unit tests
pnpm test:e2e        # playwright end-to-end tests
pnpm check           # format + lint + typecheck
pnpm check:fix       # same, with auto-fixes
```

## Pull requests

For anything bigger than a typo fix, please open an issue first and describe
what you want to change. It saves you from spending an evening on a PR that
gets rejected because the problem is already being solved differently.

The usual flow:

1. Fork the repo and create a branch from `main`: `git checkout -b my-fix`.
2. Make the change. Add or update unit tests when you change behavior.
3. Make sure `pnpm check` and `pnpm test` pass.
4. Push the branch and open a PR. Keep it focused: one fix or feature per PR.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat(plex): ...`, `fix(ui): ...`, `chore: ...`. Look at `git log` for
examples. Use the imperative mood ("add", not "added"), and reference the
issue in the body when there is one: `Fixes #12` for bugs, `Closes #12` for
features.

## Adding support for a new source

The steps are described in the [README](README.md#новый-источник)
([English](README.en.md#adding-a-source)). In short: subclass `BaseAdapter`,
register it, and regenerate the UI types. The shared pipeline takes care of
thresholds, retries and anti-spam, so a new adapter is usually small.

If you want to support a new desktop player, open an issue first: depending on
what APIs the player exposes (HTTP, IPC socket, system media integration), the
right place for it differs.
