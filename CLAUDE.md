# Working on this repository

Rules for every agent session on this repo, whatever folder or worktree it
runs in. The owner set them on 2026-11-13; they replace "PR into staging per
change".

## Branches

```
your work ──push, no CI──▶ prestaging ──batch PR, full CI──▶ staging ──owner's go-ahead──▶ main
```

- **`prestaging`** is where finished work lands. Push to it directly; no PR,
  no CI. CI (`.github/workflows/ci.yml`) only runs on PRs into `staging` and
  `main`.
- **`staging`** moves only by a **batch PR** from a snapshot of `prestaging`,
  merged when every check is green. Never push to `staging` directly and never
  open a per-change PR into it.
- **`main`** moves only when the owner says so in the current conversation.
  An approval given earlier does not carry over. `main` deploys to production
  on every push.

## Landing a change on prestaging

1. Work in your own worktree cut from `origin/prestaging`. Other sessions use
   the main checkout at the same time and switch its branch:
   ```bash
   git fetch origin
   git worktree add -b <topic> ../poker-hand-converter-wt/<topic> origin/prestaging
   ```
2. **No CI does not mean no testing.** Before pushing, run the local checks for
   what you touched (table below). A red batch PR blocks everyone else's work,
   so a change that fails its own area's checks does not get pushed.
3. Write commit messages that say what changed and why. The batch PR lists
   them, and they are how a failure gets traced back to a change.
4. Rebase and push. If the push is rejected because someone else pushed first,
   fetch and rebase again:
   ```bash
   git fetch origin && git rebase origin/prestaging && git push origin HEAD:prestaging
   ```
5. Never force-push `prestaging`.

### Local checks by area

| You touched | Run |
|---|---|
| `tests/`, `web/src/lib` parsers, stats, equity | `npm test` in `tests/`; if parser, stats or equity output changed: `npm run golden:emit` and commit `testdata/golden*/` |
| `web/` | `npm run lint && npm run lint:css && npx tsc -b` in `web/` |
| `packages/ui/` | `npm run lint && npm run lint:css && npm run typecheck` in `packages/ui/`, then `npx tsc -b` in `web/` and `npm run typecheck` in `app/` |
| `app/` (frontend) | `npm run lint && npm run lint:css && npm run typecheck` in `app/` |
| Rust (`core/`, `hud/`, `app/src-tauri`, …) | `cargo fmt --all --check`, `cargo clippy -p <crate> --all-targets --locked -- -D warnings`, `cargo test -p <crate> --locked`. Windows-only code (`#[cfg(windows)]`) does not compile on the Mac: read it by hand |
| `supabase/migrations` | apply locally (`supabase db start`, then `supabase test db`); regenerate `web/src/lib/db/database.types.ts`. Check `ls supabase/migrations` for a duplicate timestamp. Never apply a migration to production from prestaging |
| `tutorials/` | `npm run typecheck` in `tutorials/` |

Use your own cargo `target/` in a worktree. A shared `CARGO_TARGET_DIR`
builds against the main checkout's sources.

## Promoting prestaging to staging (the batch PR)

Open a batch PR when the owner asks, or when you land a change and `prestaging`
is 10 or more non-merge commits ahead of `staging`:
`git rev-list --count --no-merges origin/staging..origin/prestaging`.
First check that no batch PR is already open:
`gh pr list --base staging --search "head:batch/"`. If one is open, leave it alone.

```bash
git fetch origin
b="batch/$(date +%Y-%m-%d-%H%M)"
git push origin "origin/prestaging:refs/heads/$b"
gh pr create --base staging --head "$b" --title "Batch $(date +%Y-%m-%d): <short summary>" \
  --body "$(git log --no-merges --format='- %s' origin/staging..origin/prestaging)"
```

The PR comes from a **snapshot branch**, not from `prestaging` itself. Other
sessions keep pushing to `prestaging`, and each push would restart the ~40
minute CI on the open PR.

- **CI red:** find the change that broke it and fix it with a commit on the
  `batch/…` branch. That restarts CI for the batch only.
- **CI green:** merge only behind a gate that fails closed. GitHub auto-merge
  is off, and `gh pr checks --watch` exits 0 even when a check failed:
  ```bash
  out=$(gh pr checks N) && [ -n "$out" ] && ! printf '%s\n' "$out" | awk -F'\t' '$2!="pass"' | grep -q . \
    && gh pr merge N --merge --delete-branch --match-head-commit <sha>
  ```
  Use `--merge`, never squash. Squash merges make the next promotion conflict.
- **After the merge,** bring the fixes back into `prestaging`:
  ```bash
  git fetch origin && git checkout --detach origin/prestaging && git merge --no-edit origin/staging && git push origin HEAD:prestaging
  ```

## Promoting staging to main

Only on the owner's explicit word in that conversation.

1. Diff `supabase/migrations` between `origin/main` and `origin/staging`.
   Apply the new ones to production as soon as the promotion PR's pgTAP check
   is green, before the PR is merged.
2. Check `git merge-tree --write-tree origin/main origin/staging` for
   conflicts first.
3. Open a PR from `staging` into `main`, then merge it with the same
   fail-closed gate and `--merge`.

## GitHub rulesets

`staging` and `main` are protected by rulesets: changes only by PR, and only
with every CI check green. A direct push to either is rejected. `prestaging`
is unprotected on purpose.
