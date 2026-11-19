# First publish

The first version goes out from the user's machine, then the trust link lets CI publish every later version.

1. **Pick the source.** With release-please, publish from the open release PR's branch (its `package.json` carries the release version) in a detached worktree under `.scratch/`, so the main checkout stays untouched. The CI publish step later skips that version. Without release-please, publish from the tagged commit.
2. **Verify the source.** Install from the lockfile, run the package's checks, and show the `npm pack --dry-run` file list and version to the user.
3. **Hand over the terminal.** `npm login`, `npm publish` and `npm trust` each open a browser authentication or 2FA prompt. Run them where the user can see and answer:
   - In Herdr, call the Skill tool with `"herdr"` and split a pane beside the current one running a script that does steps 2 to 5, ending in an interactive shell.
   - Otherwise, ask the user to run each command with the `!` prefix.
4. **Publish:** `npm whoami || npm login`, then `npm publish --access public`.
5. **Trust:** `npm trust github <name> --file <workflow>.yml --repo <owner>/<repo> --allow-publish`. Without `--allow-publish` the link permits only staged publishes. It needs account-level 2FA. A link created on npmjs.com instead must see a successful publish within 2 days or it expires.
6. **Confirm.** Anonymous `npm view` can return 404 for several minutes after a first publish; `npm access get status <name>` confirms the package exists. Watch the pane or command output for the publish line (`+ <name>@<version>`) and the trust confirmation rather than trusting the final exit code.

Clean up the worktree with `git worktree remove` once the release PR is merged.
