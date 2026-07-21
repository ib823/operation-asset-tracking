# 25. Dev-container CLIs persist via postStart + profile PATH, not postCreate + remoteEnv alone

Date: 2026-07-21
Status: Accepted

## Context

`claude: not found` (and, less often, `gh: not found`) kept recurring in the Codespace — not
only after a full Rebuild Container, but after an ordinary **Stop → Start resume and
reconnect**. The convenience CLIs are installed user-globally under `~/.npm-global`; the
node:22-alpine runtime image does not bake them in.

Two independent gaps caused it:

1. **Install ran on create only.** The Claude Code and `gh` install blocks lived in
   `post-create.sh`, wired to `postCreateCommand`. `postCreateCommand` runs on container
   **create/rebuild only — never on a resume**. A Stop→Start reuses the container filesystem,
   so `~/.npm-global` usually survives; but any case where it did not (a fresh volume, a
   prebuild without the tools, a partial earlier failure) had nothing to repair it on the
   path a resume actually takes.

2. **PATH reached only VS Code shells.** `~/.npm-global/bin` was put on PATH solely via
   `remoteEnv.PATH` in `devcontainer.json`. `remoteEnv` is injected into processes VS Code
   spawns — its integrated terminal. It does **not** reach a plain `/bin/sh -l` login shell or
   a `gh cs ssh` session, which read `~/.profile` (POSIX sh / ash) and `~/.bashrc` (bash).
   From those shells the binaries existed on disk but were not resolvable — the same
   `claude: not found`, different cause.

This is the project's **verify-the-property-not-the-mechanism** maxim again: "the install
step is present and correct" (it was) is not "every shell after every start can run `claude`".
The property is the latter.

## Decision

Split tool provisioning out of create-only work and make it self-healing on every start,
reaching every shell:

- **`.devcontainer/ensure-tools.sh`** owns the CLI installs (Claude Code under `~/.npm-global`,
  rootless `gh` static binary) — the **only** place they live, no duplication. It is
  `set -uo pipefail` with every step non-fatal, and idempotent: it skips a CLI already
  resolvable, and appends `export PATH="$HOME/.npm-global/bin:$PATH"` to `~/.profile` and
  `~/.bashrc` behind a `grep` guard so the line is written once.

- **`postStartCommand: bash .devcontainer/ensure-tools.sh`** runs it on **every** container
  start — resume included — so a missing CLI self-heals with zero manual steps.

- **`post-create.sh`** keeps the create-only work (deps, `.env`, `prisma generate`,
  `db:deploy`, `db:seed`, Playwright/Chromium) and now simply calls `ensure-tools.sh` once so
  a fresh create is fully provisioned in one pass.

- **`remoteEnv.PATH` stays.** It is harmless and gives the VS Code terminal the CLIs
  immediately on attach, before/independent of the profile edits. It is a convenience, no
  longer the sole mechanism.

## Consequences

- After a Rebuild, a Stop→Start resume, or opening a fresh `/bin/sh -l`, both `command -v
claude` and `command -v gh` resolve with no manual steps.
- `postStartCommand` adds a few seconds to each start; the idempotency guards keep it a fast
  no-op once the tools and PATH lines are in place (no reinstall, no duplicate profile lines).
- The tool installs exist in exactly one file, so there is one place to update a version or
  install method.
- The profile edits are the node user's own dotfiles inside the dev container; they do not
  affect the app image or its runtime.
