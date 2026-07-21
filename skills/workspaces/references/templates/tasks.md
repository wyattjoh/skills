# Task registry

Hub-level registry for the {{WS_NAME}} workspace. Each task maps a unit of
work to a phase, the member repositories it touches, its plan batch
directories (under `plan/batches/<member>/<task-slug>/`), and the stacks
bound to it (named `{{WS_SLUG}}/<task-slug>` in each member).

Cross-repo ordering lives here: plan files inside a batch only express
dependencies within one member repo, so sequencing between members is
recorded in the "Depends on" column and enforced by running batches in that
order.

| Task          | Phase | Members            | Batches                                          | Stacks                      | Depends on | Status  |
| ------------- | ----- | ------------------ | ------------------------------------------------ | --------------------------- | ---------- | ------- |
| {{TASK_SLUG}} | 1     | {{PRIMARY_MEMBER}} | `plan/batches/{{PRIMARY_MEMBER}}/{{TASK_SLUG}}/` | `{{WS_SLUG}}/{{TASK_SLUG}}` | (none)     | planned |

Statuses: `planned` → `in-progress` → `review` → `landed` (or `dropped`,
which requires a journal entry).
