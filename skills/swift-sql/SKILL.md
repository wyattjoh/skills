---
name: swift-sql
description: 'This skill should be used when the user asks to "write a database query", "create SQL query", "use swift-structured-queries", "optimize database", "add database index", "use #sql macro", "create QueryRepresentable", "aggregate query", "GROUP BY", "window function", "ROW_NUMBER", "PARTITION BY", or mentions "SQLiteData", "GRDB", "@Table", "@Selection", "FetchKeyRequest", ".where", ".select", ".group(by:)", "covering index". Provides patterns for type-safe SQL queries in Swift using swift-structured-queries DSL.'
effort: medium
---

# Swift SQL Libraries Guide

Comprehensive patterns for swift-structured-queries, sqlite-data, and GRDB.swift in Swift projects.

## Quick Decision: DSL vs #sql Macro

| Use Case                            | Approach                   |
| ----------------------------------- | -------------------------- |
| Simple WHERE, ORDER BY              | DSL (`.where`, `.order`)   |
| JOINs                               | DSL (`.join`, `.leftJoin`) |
| Basic aggregates                    | DSL (`.count()`, `.sum()`) |
| Aggregates with FILTER              | DSL (`.count(filter:)`)    |
| Multi-column SELECT with aggregates | `@Selection` macro + DSL   |
| Window functions (ROW_NUMBER, etc.) | `#sql` macro               |
| CTEs (WITH clauses)                 | `#sql` macro               |
| Complex subqueries                  | `#sql` macro               |

**Rule of thumb:** Always prefer DSL for type safety. Use `#sql` only when DSL cannot express the query.

## Query DSL Basics

### Filtering with .where

```swift
// Simple equality
let activeDoses = try Dose
    .where { $0.medicationID.eq(medicationID) }
    .fetchAll(db)

// Comparison operators
let recentDoses = try Dose
    .where { $0.timestamp.gt(twentyFourHoursAgo) }
    .fetchAll(db)

// Compound conditions
let filtered = try Dose
    .where { $0.timestamp.gt(startDate) && $0.expirationTimestamp.lt(endDate) }
    .fetchAll(db)
```

### Ordering with .order

```swift
// Single column
let sorted = try Medication.order { $0.name.asc() }.fetchAll(db)

// Multiple columns (tuple)
let sorted = try Medication
    .order { ($0.lastDoseTimestamp.desc(), $0.name.asc()) }
    .fetchAll(db)
```

### Limiting Results

```swift
let first = try Dose.order { $0.timestamp.desc() }.limit(1).fetchOne(db)
```

## Aggregate Functions

### Basic Aggregates

```swift
// Count all rows
let count = try Medication.select { $0.count() }.fetchOne(db)

// Sum a column
let total = try Dose.select { $0.amount.sum() }.fetchOne(db)
```

### Aggregates with FILTER Clause

The FILTER clause enables conditional aggregation in a single query:

```swift
// Count only active items
Dose.select { $0.id.count(filter: $0.expirationTimestamp.gt(currentTime)) }

// Multiple conditional aggregates
Dose.select { dose in
    (
        dose.id.count(filter: dose.isActive),      // Active count
        dose.id.count(),                            // Total count
        dose.amount.sum(filter: dose.isActive)     // Active sum
    )
}
```

**Available aggregate functions with filter:**

- `.count(filter:)` - Conditional count
- `.sum(filter:)` - Conditional sum
- `.min(filter:)` - Conditional minimum
- `.max(filter:)` - Conditional maximum
- `.avg(filter:)` - Conditional average

## @Selection Macro for Complex Results

When you need multiple aggregates or joined data as a typed struct:

```swift
@Selection
struct MedicationStats {
    let medication: Medication
    let activeCount: Int
    let totalAmount: Double
}

let stats = try Medication
    .group(by: \.id)
    .leftJoin(Dose.all) { $0.id.eq($1.medicationID) }
    .select {
        MedicationStats.Columns(
            medication: $0,
            activeCount: $1.id.count(filter: $1.expirationTimestamp.gt(now)),
            totalAmount: $1.amount.sum() ?? 0
        )
    }
    .fetchAll(db)
```

**Key points:**

- Define struct with `@Selection` macro
- Use `StructName.Columns(...)` in `.select` closure
- Columns decode positionally based on SELECT order

## #sql Macro for Advanced Queries

### When DSL Falls Short

Use `#sql` for window functions, CTEs, or complex subqueries that the DSL cannot express.

### QueryRepresentable for Custom Types

Custom result types must implement `QueryRepresentable`:

```swift
private struct DoseStats: QueryRepresentable, Sendable {
    let medicationID: UUID
    let activeCount: Int
    let totalAmount: Double
    let nextExpiration: Date?

    init(decoder: inout some QueryDecoder) throws {
        // Decode in SELECT column order
        guard let medicationID = try decoder.decode(UUID.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        guard let activeCount = try decoder.decode(Int.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        guard let totalAmount = try decoder.decode(Double.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        self.medicationID = medicationID
        self.activeCount = activeCount
        self.totalAmount = totalAmount
        self.nextExpiration = try decoder.decode(Date.self)  // Optional - no guard
    }
}
```

### Window Function Example

```swift
// Get newest dose per medication using ROW_NUMBER
let newestDoses: [NewestDose] = try #sql(
    """
    SELECT "medicationID", "amount", "timestamp"
    FROM (
        SELECT "medicationID", "amount", "timestamp",
               ROW_NUMBER() OVER (PARTITION BY "medicationID" ORDER BY "timestamp" DESC) AS rn
        FROM "doses"
        WHERE "timestamp" > \(bind: twentyFourHoursAgo)
    )
    WHERE rn = 1
    """,
    as: NewestDose.self
).fetchAll(db)
```

### Aggregate with FILTER via #sql

```swift
let stats: [DoseStats] = try #sql(
    """
    SELECT
        "medicationID",
        COUNT("id") FILTER (WHERE "expirationTimestamp" > \(bind: now)) AS "activeCount",
        COALESCE(SUM("amount"), 0) AS "totalAmount",
        MIN("expirationTimestamp") FILTER (WHERE "expirationTimestamp" > \(bind: now))
    FROM "doses"
    WHERE "timestamp" > \(bind: twentyFourHoursAgo)
    GROUP BY "medicationID"
    """,
    as: DoseStats.self
).fetchAll(db)
```

### Binding Values

```swift
// Use \(bind: value) for safe parameter binding
#sql("SELECT * FROM doses WHERE timestamp > \(bind: startDate)", as: Dose.self)

// Interpolate schema elements safely
#sql("SELECT \(Dose.columns) FROM \(Dose.self)", as: Dose.self)
```

## Database Configuration

### Essential Configuration

```swift
var configuration = Configuration()
configuration.foreignKeysEnabled = true
configuration.busyMode = .timeout(5)  // Prevents SQLITE_BUSY with concurrent access
```

### WAL Mode for Widget/Extension Access

```swift
configuration.prepareDatabase { db in
    // Enable persistent WAL for read-only connections (widgets)
    if db.configuration.readonly == false {
        var flag: CInt = 1
        sqlite3_file_control(db.sqliteConnection, nil, SQLITE_FCNTL_PERSIST_WAL, &flag)
    }
}
```

### Debug Query Tracing

```swift
#if DEBUG
db.trace(options: .profile) { query in
    Logger.data.debug(query.expandedDescription)
}
#endif
```

## FetchKeyRequest Pattern

For TCA/SwiftUI integration with automatic refreshes:

```swift
struct DosesRequest: FetchKeyRequest {
    struct Value: Sendable {
        var rows: [Row] = []
        var loading = true
    }

    func fetch(_ db: Database) throws -> Value {
        // CRITICAL: Read time from dependency for auto-refresh
        @Dependency(\.date.now) var currentTime

        let rows = try Dose
            .where { $0.timestamp.gt(currentTime.addingTimeInterval(-24 * 3600)) }
            .fetchAll(db)

        return Value(rows: rows, loading: false)
    }
}

// Usage in TCA feature
@ObservationStateIgnored
@Fetch var data = DosesRequest.Value()

// Load data
try await $data.load(DosesRequest(), animation: .default)
```

## Quick Reference

### Index Optimization

See `references/OPTIMIZATION.md` for detailed index strategies including:

- Covering indexes for aggregation queries
- Composite indexes for filtered lookups
- Index-only scan patterns

### Detailed Query Patterns

See `references/QUERY-PATTERNS.md` for additional examples:

- Complex JOINs
- Subquery patterns
- Migration examples
