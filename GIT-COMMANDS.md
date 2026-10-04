# Git push commands

Run these in the project Shell. Commit your changes first: pushing sends
commits, not uncommitted edits. Check your current branch with:

```bash
git status --short --branch
```

These commands use your GitHub CLI login instead of Replit's Git credential.
They do not force-push or create release tags.

## Push the testing branch

```bash
(
  unset GH_TOKEN GITHUB_TOKEN
  git -c credential.helper= \
      -c 'credential.helper=!gh auth git-credential' \
      push -u origin testing
)
```

This pushes the local `testing` branch to GitHub's `testing` branch and
triggers the testing Docker workflow. Update the TrueNAS test app manually
after the build succeeds.

## Push the main branch

```bash
(
  unset GH_TOKEN GITHUB_TOKEN
  git -c credential.helper= \
      -c 'credential.helper=!gh auth git-credential' \
      push -u origin main
)
```

This pushes the local `main` branch to GitHub's `main` branch. It does not
merge changes from `testing`, publish a stable release, or update TrueNAS.
Merge tested changes into `main` first (for example, through a GitHub pull
request), as appropriate. Version tags trigger stable releases separately.

**Branch names matter:** each command pushes the named local branch,
regardless of which branch is currently checked out. If you committed on
`testing`, pushing `main` will not include those commits unless they have
also been merged into `main`.

## Sign in again if workflow permission is missing

If GitHub rejects `.github/workflows/` changes for missing `workflow` scope,
run this and follow the browser authorization instructions:

```bash
(
  unset GH_TOKEN GITHUB_TOKEN
  gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow
)
```

Then retry the appropriate push command above. If asked to authenticate Git
with your GitHub credentials, choose **Yes**. Do not paste tokens into chat
or put them in remote URLs.

If a push is rejected because the remote has newer commits, stop and
reconcile the branches before retrying. Do not use `--force`.