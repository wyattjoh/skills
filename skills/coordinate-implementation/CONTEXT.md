# Implementation Coordination

Implementation Coordination moves agreed tickets through implementation and
review into one locally verified body of work.

## Language

**Run**:
An approved set of tickets pursued together toward one specification.
_Avoid_: Engine, workflow script

**Coordinator**:
The agent responsible for a run's assignments, decisions, progress, and integration.
_Avoid_: Engine, daemon

**Integration Branch**:
The dedicated destination for a run's completed tickets, separate from repository trunk.
_Avoid_: main, shared base

**Frontier**:
The pending tickets whose prerequisites have all landed and which can therefore begin.
_Avoid_: next file, ordered checklist

**In-flight Ticket**:
A ticket actively progressing from implementation through landing, including review
and fixes. Blocked and landed tickets are not in flight.
_Avoid_: implementor count, session count

**Landed Ticket**:
A ticket whose approved, checked work has been integrated into the run's integration branch.
_Avoid_: done, idle, implementation complete

**Cold Resume**:
A replacement coordinator's continuation of a run from its durable evidence and
observed work, without relying on the former coordinator's conversation or harness.
_Avoid_: model migration, Engine restart

**Worker Migration**:
An explicitly approved change to the harness, model, or effort assigned to unfinished
worker work, preserving that work rather than starting the ticket over.
_Avoid_: coordinator takeover, automatic fallback
