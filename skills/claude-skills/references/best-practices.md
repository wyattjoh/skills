# Skill Authoring Best Practices

Detailed guidance from the official Anthropic documentation on writing effective
skills.

## Core Principles

### Concise is Key

The context window is a shared resource. Your skill competes with conversation
history, other skills' metadata, and the system prompt. At startup, only metadata
(name and description) is pre-loaded. SKILL.md loads only when triggered.
Additional files load only when referenced.

**Default assumption:** Claude is already very smart. Only add context Claude
doesn't already have. Challenge each piece of information:

- "Does Claude really need this explanation?"
- "Can I assume Claude knows this?"
- "Does this paragraph justify its token cost?"

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

**High freedom** (text-based instructions): Use when multiple approaches are
valid and decisions depend on context. Example: code review guidelines.

**Medium freedom** (pseudocode or scripts with parameters): Use when a preferred
pattern exists but some variation is acceptable. Example: report generation
templates.

**Low freedom** (specific scripts, few parameters): Use when operations are
fragile, consistency is critical, or a specific sequence must be followed.
Example: database migrations.

Think of it as: narrow bridge with cliffs (low freedom, exact instructions) vs.
open field (high freedom, general direction).

### Test with All Models

Skills act as additions to models, so effectiveness depends on the underlying
model. What works perfectly for Opus might need more detail for Haiku:

- **Haiku**: Does the skill provide enough guidance?
- **Sonnet**: Is the skill clear and efficient?
- **Opus**: Does the skill avoid over-explaining?

## Progressive Disclosure Patterns

### Pattern 1: High-Level Guide with References

```markdown
# PDF Processing

## Quick start

[Core usage example]

## Advanced features

**Form filling**: See [FORMS.md](FORMS.md) for complete guide
**API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
```

Claude loads FORMS.md or REFERENCE.md only when needed.

### Pattern 2: Domain-Specific Organization

For skills with multiple domains, organize by domain to avoid loading irrelevant
context:

```
bigquery-skill/
  SKILL.md (overview and navigation)
  reference/
    finance.md
    sales.md
    product.md
```

### Pattern 3: Conditional Details

```markdown
## Creating documents

Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing documents

For simple edits, modify the XML directly.
**For tracked changes**: See [REDLINING.md](REDLINING.md)
```

### Avoid Deeply Nested References

Claude may partially read files when they're referenced from other referenced
files. **Keep references one level deep from SKILL.md.**

Bad: SKILL.md -> advanced.md -> details.md (actual info here)
Good: SKILL.md -> advanced.md, SKILL.md -> reference.md (all one level)

### Structure Long Reference Files

For reference files longer than 100 lines, include a table of contents at the
top so Claude can navigate efficiently.

## Evaluation-Driven Development

**Create evaluations BEFORE writing extensive documentation.** This ensures your
skill solves real problems.

1. **Identify gaps:** Run Claude on representative tasks without a skill.
   Document specific failures or missing context
2. **Create evaluations:** Build three scenarios that test these gaps
3. **Establish baseline:** Measure Claude's performance without the skill
4. **Write minimal instructions:** Create just enough content to pass evaluations
5. **Iterate:** Execute evaluations, compare against baseline, refine

## Iterative Development with Claude

Work with one Claude instance ("Claude A") to create a skill used by others
("Claude B"):

1. Complete a task without a skill, noting what info you repeatedly provide
2. Ask Claude A to create a skill capturing the reusable pattern
3. Review for conciseness, remove unnecessary explanations
4. Test on similar tasks with Claude B (fresh instance with skill loaded)
5. If Claude B struggles, return to Claude A with specifics
6. Repeat based on usage

## Content Guidelines

### Avoid Time-Sensitive Information

Bad: "If you're doing this before August 2025, use the old API."

Good: Use a **"Current method"** section for the recommended approach and an
**"Old patterns"** section (collapsible `<details>` block) for deprecated
content that users may encounter in legacy codebases. This preserves historical
context without cluttering the main flow.

```markdown
## Current method

Use the v2 API endpoint: `api.example.com/v2/messages`

## Old patterns

<details>
<summary>Legacy v1 API (deprecated)</summary>

The v1 API used: `api.example.com/v1/messages`

This endpoint is no longer supported.

</details>
```

### Use Consistent Terminology

Choose one term and use it throughout. Don't mix "API endpoint" / "URL" /
"API route" / "path" for the same concept.

### Template Pattern

Provide templates for output format. Match strictness to your needs:

- **Strict** (API responses, data formats): "ALWAYS use this exact template"
- **Flexible** (when adaptation is useful): "Sensible default, adjust as needed"

### Examples Pattern

For skills where output quality depends on examples, provide input/output pairs
just like in regular prompting.

### Conditional Workflow Pattern

Guide through decision points: "Creating new content? -> Follow Creation
workflow. Editing existing? -> Follow Editing workflow."

## Workflow Patterns

These patterns help Claude stay on track through multi-step work by making
progress observable, intermediate state verifiable, and errors correctable.
They compose: a workflow checklist plus a feedback loop plus a plan-validate-
execute pattern work together for script-driven skills, while simpler skills
may only need the checklist.

### Workflow Checklists

For complex multi-step work, provide a checklist that Claude can copy into
its response and check off as it progresses. This prevents Claude from
skipping validation steps and gives both Claude and the user a shared
progress indicator.

````markdown
## Migration workflow

Copy this checklist and track progress:

```
Migration Progress:
- [ ] Step 1: Back up the database
- [ ] Step 2: Run pre-migration validation
- [ ] Step 3: Apply schema changes
- [ ] Step 4: Run post-migration checks
- [ ] Step 5: Verify data integrity
```

**Step 1: Back up the database**

Run: `./scripts/backup.sh`

**Step 2: Run pre-migration validation**
...
````

The checklist pattern works for workflows with or without code. For
code-less workflows (research synthesis, document review), the "validator"
is a reference document rather than a script.

### Feedback Loops

The common pattern is **run validator -> fix errors -> repeat**. This
dramatically improves output quality compared to one-shot attempts.

```markdown
## Document editing process

1. Make your edits to `word/document.xml`
2. Validate immediately: `python scripts/validate.py unpacked/`
3. If validation fails:
   - Review the error message carefully
   - Fix the issues in the XML
   - Run validation again
4. Only proceed when validation passes
5. Rebuild: `python scripts/pack.py unpacked/ output.docx`
```

For skills without scripts, the validator can be a style guide or a
reference document that Claude compares the output against.

### Plan-Validate-Execute

For complex, open-ended operations (batch edits, destructive changes, high-
stakes operations), have Claude create a plan file first, validate the plan
with a script, then execute the plan. This catches errors early, when the
cost of iterating on the plan is much lower than the cost of undoing a bad
execution.

```markdown
## Batch field update workflow

1. Analyze input: `python scripts/analyze.py input.pdf > plan.json`
2. Edit `plan.json` to add field values
3. Validate plan: `python scripts/validate_plan.py plan.json`
   - Fix any errors before continuing
4. Execute: `python scripts/apply_plan.py input.pdf plan.json output.pdf`
5. Verify: `python scripts/verify.py output.pdf`
```

The intermediate `plan.json` file is machine-verifiable, reversible (edit
it freely without touching originals), and produces clear error messages
that point to specific problems.

**When to use:** Batch operations, destructive changes, complex validation
rules, any high-stakes operation where a single bad execution is expensive
to recover from.

## Script-Authoring Guidelines

### Solve, Don't Punt

When writing scripts bundled with a skill, handle error conditions
explicitly rather than deferring to Claude. If you don't know the right
thing to do in an error case, Claude almost certainly can't figure it out
from a stack trace either.

**Bad - punts to Claude:**

```python
def process_file(path):
    return open(path).read()  # Just crashes on errors
```

**Good - handles errors explicitly:**

```python
def process_file(path):
    """Process a file, creating it if missing."""
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        print(f"File {path} not found, creating default")
        with open(path, "w") as f:
            f.write("")
        return ""
    except PermissionError:
        print(f"Cannot access {path}, using default")
        return ""
```

Similarly, avoid **voodoo constants** - document why each magic number
exists. If you can't explain why `TIMEOUT = 47`, Claude can't either:

```python
# HTTP requests typically complete within 30 seconds.
# Longer timeout accounts for slow connections.
REQUEST_TIMEOUT = 30
```

### Make Error Messages Verbose and Specific

Validation scripts should tell Claude exactly what went wrong and what
options exist. Instead of `ValueError: invalid field`, prefer:

```
Field 'signature_date' not found.
Available fields: customer_name, order_total, signature_date_signed
```

The list of available options lets Claude fix the error without another
round trip to analyze the input.

## MCP Tool References

If your skill uses MCP (Model Context Protocol) tools, always use fully
qualified tool names to avoid "tool not found" errors.

**Format:** `ServerName:tool_name`

```markdown
Use the BigQuery:bigquery_schema tool to retrieve table schemas.
Use the GitHub:create_issue tool to create issues.
```

Without the server prefix, Claude may fail to locate the tool when multiple MCP
servers are available.

## Anti-Patterns to Avoid

1. **Too many options**: Don't list 5 libraries. Provide a default with an
   escape hatch for edge cases.
2. **Deeply nested references**: Keep reference files one level deep from
   SKILL.md.
3. **Over-explaining**: Claude knows what PDFs are. Skip the background.
4. **Windows-style paths**: Always use forward slashes, even on Windows.
5. **Vague descriptions**: "Helps with documents" tells Claude nothing useful.
6. **Time-sensitive info**: Dates become wrong. Use "current" vs "legacy"
   sections.
7. **Inconsistent terminology**: Pick one term per concept and stick with it.

## Checklist for Effective Skills

### Core Quality

- [ ] Description is specific and includes key terms
- [ ] Description includes both what the skill does and when to use it
- [ ] SKILL.md body is under 500 lines
- [ ] Additional details are in separate files (if needed)
- [ ] No time-sensitive information
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract
- [ ] File references are one level deep
- [ ] Progressive disclosure used appropriately
- [ ] Workflows have clear steps

### Code and Scripts

- [ ] Scripts solve problems rather than punt to Claude
- [ ] Error handling is explicit and helpful
- [ ] Required packages listed and verified as available
- [ ] No Windows-style paths (all forward slashes)
- [ ] Validation/verification steps for critical operations
- [ ] Feedback loops included for quality-critical tasks

### Testing

- [ ] At least three evaluations created
- [ ] Tested with Haiku, Sonnet, and Opus
- [ ] Tested with real usage scenarios
- [ ] Team feedback incorporated (if applicable)
