# Use an immutable Assessment lifecycle

An Assessment uses three phases: prepare an immutable request from authoritative state, evaluate that exact request into immutable Assessment Evidence, then apply a Disposition only after verifying the binding and current invariants. This costs more artifacts than a single assess-and-mutate operation, but it makes each attempt immutable, requires retries to link to unchanged failed evidence, makes stale evidence rejectable and failures auditable, and prevents model execution from mutating run state directly.
