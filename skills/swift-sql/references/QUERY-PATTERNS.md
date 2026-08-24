# Query Patterns Reference

Detailed examples for swift-structured-queries DSL and #sql macro patterns.

## DSL Query Patterns

### Chained Query Building

```swift
// Build queries incrementally
var query = Dose.all

if let medicationID = filterMedicationID {
    query = query.where { $0.medicationID.eq(medicationID) }
}

if onlyActive {
    query = query.where { $0.expirationTimestamp.gt(Date()) }
}

let results = try query.order { $0.timestamp.desc() }.fetchAll(db)
```

### JOINs

```swift
// Inner JOIN
let dosesWithMedications = try Dose
    .join(Medication.all) { $0.medicationID.eq($1.id) }
    .select { ($0, $1) }  // Tuple of both tables
    .fetchAll(db)

// Left JOIN (medication may be nil)
let dosesWithOptionalMedications = try Dose
    .leftJoin(Medication.all) { $0.medicationID.eq($1.id) }
    .select { ($0, $1) }  // $1 is Optional<Medication>
    .fetchAll(db)
```

### GROUP BY with Multiple Aggregates

```swift
@Selection
struct DailySummary {
    let date: Date
    let totalDoses: Int
    let totalAmount: Double
    let avgAmount: Double?
}

let summary = try Dose
    .group(by: \.date)  // Assuming date column exists
    .select {
        DailySummary.Columns(
            date: $0.date,
            totalDoses: $0.id.count(),
            totalAmount: $0.amount.sum() ?? 0,
            avgAmount: $0.amount.avg()
        )
    }
    .fetchAll(db)
```

### Computed Column Extensions

Add reusable query expressions to table columns:

```swift
extension Dose.TableColumns {
    var isActive: some QueryExpression<Bool> {
        expirationTimestamp.gt(#sql("datetime('now')"))
    }

    var isExpiringSoon: some QueryExpression<Bool> {
        expirationTimestamp.gt(#sql("datetime('now')"))
            && expirationTimestamp.lt(#sql("datetime('now', '+1 hour')"))
    }
}

// Use in queries
let urgentDoses = try Dose.where { $0.isExpiringSoon }.fetchAll(db)
let activeCount = try Dose.select { $0.count(filter: $0.isActive) }.fetchOne(db)
```

## #sql Macro Patterns

### CTE (Common Table Expression)

```swift
struct RankedDose: QueryRepresentable, Sendable {
    let id: UUID
    let rank: Int

    init(decoder: inout some QueryDecoder) throws {
        guard let id = try decoder.decode(UUID.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        guard let rank = try decoder.decode(Int.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        self.id = id
        self.rank = rank
    }
}

let ranked: [RankedDose] = try #sql(
    """
    WITH ranked_doses AS (
        SELECT "id",
               DENSE_RANK() OVER (ORDER BY "amount" DESC) AS rank
        FROM "doses"
        WHERE "timestamp" > \(bind: startDate)
    )
    SELECT "id", "rank"
    FROM ranked_doses
    WHERE "rank" <= 10
    """,
    as: RankedDose.self
).fetchAll(db)
```

### Recursive CTE

```swift
// Example: Find all related items in a hierarchy
let hierarchy: [Item] = try #sql(
    """
    WITH RECURSIVE ancestors AS (
        SELECT * FROM items WHERE id = \(bind: itemID)
        UNION ALL
        SELECT i.* FROM items i
        JOIN ancestors a ON i.id = a.parentID
    )
    SELECT \(Item.columns) FROM ancestors
    """,
    as: Item.self
).fetchAll(db)
```

### Complex Subqueries

```swift
struct MedicationWithLastDose: QueryRepresentable, Sendable {
    let medication: Medication
    let lastDoseAmount: Double?
    let lastDoseTime: Date?

    init(decoder: inout some QueryDecoder) throws {
        self.medication = try Medication(decoder: &decoder)
        self.lastDoseAmount = try decoder.decode(Double.self)
        self.lastDoseTime = try decoder.decode(Date.self)
    }
}

let results: [MedicationWithLastDose] = try #sql(
    """
    SELECT
        \(Medication.columns),
        (SELECT "amount" FROM "doses" WHERE "medicationID" = m."id"
         ORDER BY "timestamp" DESC LIMIT 1) AS "lastDoseAmount",
        (SELECT "timestamp" FROM "doses" WHERE "medicationID" = m."id"
         ORDER BY "timestamp" DESC LIMIT 1) AS "lastDoseTime"
    FROM "medications" m
    """,
    as: MedicationWithLastDose.self
).fetchAll(db)
```

### CASE Expressions

```swift
struct DoseCategory: QueryRepresentable, Sendable {
    let id: UUID
    let category: String

    init(decoder: inout some QueryDecoder) throws {
        guard let id = try decoder.decode(UUID.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        guard let category = try decoder.decode(String.self) else {
            throw QueryDecodingError.missingRequiredColumn
        }
        self.id = id
        self.category = category
    }
}

let categorized: [DoseCategory] = try #sql(
    """
    SELECT "id",
           CASE
               WHEN "amount" < 10 THEN 'low'
               WHEN "amount" < 50 THEN 'medium'
               ELSE 'high'
           END AS "category"
    FROM "doses"
    """,
    as: DoseCategory.self
).fetchAll(db)
```

## Migration Patterns

### Adding Indexes

```swift
migrator.registerMigration("Add covering index") { db in
    try #sql(
        """
        CREATE INDEX IF NOT EXISTS "idx_doses_covering"
        ON "doses"("timestamp" DESC, "medicationID", "amount")
        """
    ).execute(db)
}
```

### Adding Columns

```swift
migrator.registerMigration("Add price column") { db in
    try #sql(
        """
        ALTER TABLE "medications"
        ADD COLUMN "pricePerUnit" REAL
        """
    ).execute(db)
}
```

### Creating Triggers

```swift
migrator.registerMigration("Add timestamp trigger") { db in
    try db.execute(sql: """
        CREATE TRIGGER "trigger_doses_insert"
        AFTER INSERT ON "doses"
        FOR EACH ROW
        BEGIN
            UPDATE "medications"
            SET "lastDoseTimestamp" = (
                SELECT MAX("timestamp") FROM "doses"
                WHERE "medicationID" = NEW."medicationID"
            )
            WHERE "id" = NEW."medicationID";
        END
    """)
}
```

## Error Handling

### QueryDecodingError

```swift
do {
    let results = try #sql("...", as: MyType.self).fetchAll(db)
} catch QueryDecodingError.missingRequiredColumn {
    // A non-optional column was NULL
} catch {
    // Other database errors
}
```

### Database Errors

```swift
do {
    try database.write { db in
        try dose.insert(db)
    }
} catch let error as DatabaseError where error.resultCode == .SQLITE_CONSTRAINT {
    // Foreign key or unique constraint violation
} catch let error as DatabaseError where error.resultCode == .SQLITE_BUSY {
    // Database locked - increase busyMode timeout
}
```
