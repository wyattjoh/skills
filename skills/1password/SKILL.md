---
name: 1password
description: Operates on 1Password vaults through the JavaScript SDK with desktop-app auth, so a whole batch of reads or writes costs one biometric prompt instead of one per `op` call. Use when reading secrets or secret references (`op://`), listing or inspecting vaults and items, creating, editing, or deleting items, or populating env files or commands from 1Password.
---

# 1Password

## Goal

Every 1Password operation runs as one Bun script in one process. That process holds one SDK client authenticated through the desktop app, so the user approves a single biometric prompt for the whole job. Each separate process prompts again, and so does each `op` CLI call made from an agent shell. Spending one process per operation is the point of this skill.

## Completion criteria

- The user saw one prompt per approved batch. Gather every reference, item ID, and write first, then run once.
- No secret value entered the transcript unless the user asked to see it. Scripts print names, IDs, counts, and per-entry status. Values go straight to their destination: a file created with mode `0600`, or the `env` of a spawned child process.
- Every entry in a batch response was checked. Batch calls report failures per entry, and the script reports each failed entry by name.

## Boundaries

- Reads (resolve, list, get) run without asking.
- Writes (`create`, `createAll`, `put`, `delete`, `deleteAll`, `archive`, and any vault change) first show the plan: account, vault, item titles, field labels, and never values. They run as one batch after the user confirms that plan.
- The account is chosen at runtime. `op account list --format json` prints accounts without prompting. Pass the matching `account_uuid` to `DesktopAuth`, and ask the user when the request fits more than one account.
- Keep account emails, UUIDs, and item values out of committed files.

## Running a script

Write the script in `.scratch/1password/` of the current repository, or in a fresh temp directory outside one. Give that directory its own `package.json` before installing, because `bun add` otherwise walks up and edits the enclosing project's manifest. The snippet below matches SDK 0.5.0, so install that version:

```sh
cd .scratch/1password
echo '{ "private": true }' > package.json
bun add @1password/sdk@0.5.0
bun op.ts
```

```ts
import { createClient, DesktopAuth } from "@1password/sdk";

const op = await createClient({
  auth: new DesktopAuth(accountUuid), // the one biometric prompt
  integrationName: "claude-code",
  integrationVersion: "1.0.0",
});

const { individualResponses } = await op.secrets.resolveAll(refs);
for (const [ref, r] of Object.entries(individualResponses)) {
  console.log(ref, r.error ? `failed: ${r.error.type}` : "ok");
}
```

Use the batch method whenever one exists:

| Need               | Call                                                  |
| ------------------ | ----------------------------------------------------- |
| Many secret values | `secrets.resolveAll(refs)`, keyed by reference        |
| Many items         | `items.getAll(vaultId, itemIds)`                      |
| Create many items  | `items.createAll(vaultId, params)`                    |
| Delete many items  | `items.deleteAll(vaultId, itemIds)`                   |
| Find items         | `vaults.list()`, then `items.list(vaultId)` per vault |

`vaults.list()` maps vault names to IDs. Items reached through `op://vault/item/field` references need no IDs. Responses report failures per entry as `{ content?, error? }`. For anything else, read the SDK's `node_modules/@1password/sdk/dist/*.d.ts` once it is installed.

## Recovery

- `Account not found`: the UUID or name doesn't match a signed-in account. Recheck `op account list`.
- `1Password desktop application not found`, or authentication fails with the app installed: ask the user to unlock the app and turn on Settings > Developer > Integrate with the 1Password SDKs > "Integrate with other apps".
- Partial batch failure: report the failed entries, then rerun only those, as one new batch.
