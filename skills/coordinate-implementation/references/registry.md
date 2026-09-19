# Cross-run registry contract

`.scratch/coordinators.md` is the repository-wide discovery boundary for
`coordinate-implementation` runs. The canonical copy is in the integration
checkout selected by repository policy. Copies in ticket or base worktrees are
stale and must not be used for coordination.

## Schema

The file contains one Markdown table with this exact header:

```text
| prefix | base | run folder | workspace | coordinator pane | generation | run status | active tickets | updated |
```

Each field has one stable meaning:

| Field              | Contract                                                       |
| ------------------ | -------------------------------------------------------------- |
| `prefix`           | Unique run identifier matching `Prefix:` in RESUME.md          |
| `base`             | Local integration branch matching `Base:`                      |
| `run folder`       | Repository-relative normalized run directory                   |
| `workspace`        | Current Herdr workspace identity                               |
| `coordinator pane` | Current pane from `Coordinator ownership:`                     |
| `generation`       | Current ownership generation                                   |
| `run status`       | `active`, `waiting`, or `completed` from `## Run outcome`      |
| `active tickets`   | Sorted ticket numbers with active implementor runtimes, or `-` |
| `updated`          | UTC ISO-8601 timestamp for the row revision                    |

A run without `## Run outcome` is `active`. A `waiting` run has no runnable
frontier and still has blocked or dependency-blocked work. `completed` means
every ticket is `landed` or explicitly `closed` and a local `SUMMARY.md`
exists.

## Ownership

Only the run's current ready coordinator may add, update, or remove that run's
row. Ownership is proven by the schema-1 `Coordinator ownership:` generation,
pane, and readiness fields. A predecessor that handed off and a downstream
multi-run coordinator are readers, not row owners.

A downstream coordinator may own a separate `## Cross-run agreements` section
for merge order and shared-file assignments. It never repairs a run row and
never edits a run's RESUME.md. It reports drift to the owning run coordinator,
then waits for that owner to update both records.

The run records `completed` before its coordinator closes. Keep the completed
row as a discovery tombstone while a downstream coordinator still needs to
observe completion. The run owner removes its row only after downstream
acknowledgement or when no downstream coordinator exists.

## Reader protocol

For each row, a downstream reader:

1. reads the referenced RESUME.md without modifying it;
2. rejects unsupported `Schema version:` values without migration;
3. verifies `Prefix`, `Base`, ownership generation, pane, and run status against
   the row;
4. refreshes stale pane identifiers through Herdr's machine-readable control
   surface;
5. treats `waiting` as unfinished and `completed` as terminal only when
   `SUMMARY.md` exists;
6. sends discrepancies to the row owner rather than rewriting either record.
