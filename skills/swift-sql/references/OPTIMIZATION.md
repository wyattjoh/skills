# Database Optimization Reference

Index strategies, configuration patterns, and performance optimization for SQLite with GRDB.

## Index Strategies

### Covering Indexes

A covering index includes all columns needed for a query, enabling **index-only scans** without reading table data.

```sql
-- For query: SELECT medicationID, SUM(amount) FROM doses WHERE timestamp > ? GROUP BY medicationID
CREATE INDEX "idx_doses_aggregation_covering"
ON "doses"("timestamp" DESC, "medicationID", "expirationTimestamp", "amount")
```

**Column order matters:**

1. First: Columns in WHERE clause (for filtering)
2. Next: Columns in GROUP BY (for grouping)
3. Last: Columns in SELECT (to avoid table lookup)

### Composite Indexes

For queries filtering on multiple columns:

```sql
-- For query: WHERE medicationID = ? AND expirationTimestamp > ?
CREATE INDEX "idx_doses_medication_expiration"
ON "doses"("medicationID", "expirationTimestamp")

-- For query: ORDER BY lastDoseTimestamp DESC, name ASC
CREATE INDEX "idx_medications_lastdose_name"
ON "medications"("lastDoseTimestamp", "name")
```

### Index Selection Guidelines

| Query Pattern                  | Index Strategy                             |
| ------------------------------ | ------------------------------------------ |
| `WHERE col = ?`                | Single-column index on `col`               |
| `WHERE col1 = ? AND col2 > ?`  | Composite index `(col1, col2)`             |
| `GROUP BY col` with aggregates | Covering index including aggregate columns |
| `ORDER BY col1, col2`          | Composite index matching order direction   |
| `WHERE col IN (...)`           | Single-column index on `col`               |

### When NOT to Index

- Columns with low cardinality (e.g., boolean flags)
- Tables with very few rows (<1000)
- Columns rarely used in WHERE/JOIN/ORDER BY
- Write-heavy tables where index maintenance outweighs read benefits

## Configuration Optimization

### Busy Timeout (Concurrent Access)

Prevents `SQLITE_BUSY` errors when app and widgets access simultaneously:

```swift
var configuration = Configuration()
configuration.busyMode = .timeout(5)  // Wait up to 5 seconds for locks
```

### WAL Mode for Multi-Process Access

Enable persistent WAL for widget/extension read access:

```swift
configuration.prepareDatabase { db in
    if db.configuration.readonly == false {
        var flag: CInt = 1
        let code = withUnsafeMutablePointer(to: &flag) { flagP in
            sqlite3_file_control(db.sqliteConnection, nil, SQLITE_FCNTL_PERSIST_WAL, flagP)
        }
        guard code == SQLITE_OK else {
            throw DatabaseError(resultCode: ResultCode(rawValue: code))
        }
    }
}
```

**Why persistent WAL?**

- Default WAL mode deletes `-shm` and `-wal` files on last connection close
- This breaks read-only connections (widgets) that need those files
- Persistent WAL keeps files around for multi-process access

### Read-Only Database for Widgets

```swift
func widgetDatabase() throws -> DatabasePool? {
    var config = Configuration()
    config.readonly = true
    config.busyMode = .timeout(5)

    return try DatabasePool(path: dbPath, configuration: config)
}
```

## Query Optimization Patterns

### Avoid N+1 Queries

```swift
// BAD: N+1 queries
let medications = try Medication.fetchAll(db)
for medication in medications {
    let doses = try Dose.where { $0.medicationID == medication.id }.fetchAll(db)
}

// GOOD: Single query with JOIN or batch fetch
let dosesByMedication = Dictionary(
    grouping: try Dose.fetchAll(db),
    by: \.medicationID
)
for medication in try Medication.fetchAll(db) {
    let doses = dosesByMedication[medication.id] ?? []
}
```

### Batch Operations

```swift
// GOOD: Single transaction for multiple writes
try database.write { db in
    for dose in dosesToInsert {
        try dose.insert(db)
    }
}

// BAD: Multiple transactions
for dose in dosesToInsert {
    try database.write { db in
        try dose.insert(db)
    }
}
```

### Limit Data Transfer

```swift
// GOOD: Select only needed columns
let names = try Medication.select { $0.name }.fetchAll(db)

// GOOD: Use aggregates instead of fetching all rows
let totalAmount = try Dose.select { $0.amount.sum() }.fetchOne(db)

// BAD: Fetch all rows to count/sum in Swift
let doses = try Dose.fetchAll(db)
let total = doses.reduce(0) { $0 + $1.amount }
```

### Use Database Triggers

Move repetitive update logic to triggers:

```sql
-- Instead of updating lastDoseTimestamp in Swift after each insert
CREATE TRIGGER "trigger_doses_insert_lastDoseTimestamp"
AFTER INSERT ON "doses"
FOR EACH ROW
BEGIN
    UPDATE "medications"
    SET "lastDoseTimestamp" = (
        SELECT MAX("timestamp") FROM "doses" WHERE "medicationID" = NEW."medicationID"
    )
    WHERE "id" = NEW."medicationID";
END
```

## Algorithm Optimization

### Rolling Window Calculations

For calculating rolling sums (e.g., 24-hour totals at multiple points):

**Naive approach: O(samples × N)**

```swift
// BAD: Recalculates for each sample point
for sampleTime in sampleTimes {
    let sum = doses.filter { isInWindow($0, sampleTime) }.reduce(0) { $0 + $1.amount }
}
```

**Optimized approach: O(N log N + samples × log N)**

```swift
// GOOD: Sort once, build prefix sums, binary search for bounds
let sortedDoses = doses.sorted { $0.timestamp < $1.timestamp }

// Build prefix sum array
var prefixSums = [Double](repeating: 0, count: sortedDoses.count + 1)
for i in 0..<sortedDoses.count {
    prefixSums[i + 1] = prefixSums[i] + sortedDoses[i].amount
}

// For each sample: O(log N) binary search + O(1) range sum
for sampleTime in sampleTimes {
    let startIdx = binarySearchFirst(in: sortedDoses) { $0.timestamp > windowStart }
    let endIdx = binarySearchFirst(in: sortedDoses) { $0.timestamp > sampleTime }
    let windowSum = prefixSums[endIdx] - prefixSums[startIdx]
}
```

## Monitoring Performance

### Query Tracing

```swift
#if DEBUG
db.trace(options: .profile) { query in
    // Skip noisy iCloud queries if needed
    if query.expandedDescription.contains("icloud") { return }
    Logger.data.debug(query.expandedDescription)
}
#endif
```

### Timing Database Operations

```swift
let startTime = CFAbsoluteTimeGetCurrent()
try migrator.migrate(database)
Logger.data.timing("Database migrations", duration: CFAbsoluteTimeGetCurrent() - startTime)
```

## Common Performance Issues

| Symptom            | Likely Cause                | Solution                                        |
| ------------------ | --------------------------- | ----------------------------------------------- |
| Slow startup       | Migrations running          | Make migrations idempotent, use `IF NOT EXISTS` |
| SQLITE_BUSY errors | Concurrent access           | Increase `busyMode` timeout                     |
| Slow aggregation   | Missing covering index      | Add index including all SELECT columns          |
| UI jank on fetch   | Main thread database access | Use async fetch with background queue           |
| High memory usage  | Fetching too many rows      | Use pagination or streaming cursors             |
