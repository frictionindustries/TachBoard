---
name: GitHub workflow push authorization
description: Confirmed credential workaround for pushing workflow changes from this workspace
---

Use an explicitly selected GitHub CLI credential helper when pushing workflow changes from this workspace.

**Why:** Replit's OAuth credential rejected workflow-file pushes for missing `workflow` scope. The user confirmed that browser login with `repo,workflow`, unsetting GH_TOKEN/GITHUB_TOKEN in a subshell, and overriding the Git credential helper successfully created the testing branch.

**How to apply:** see GIT-COMMANDS.md for the saved commands. Do not assume a generic PUSH_REJECTED message means diverged history; inspect the actual remote error. Never force-push to solve an authorization failure.