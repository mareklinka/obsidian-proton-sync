# Software Development Life Cycle (SDLC) – AI Agent Workflow

This document defines the mandatory SDLC stages that AI agents MUST follow when working on this project. Phase transitions are **HARD** — the agent MUST NOT skip, merge, or bypass any stage.

---

## Stage 1 — Requirements Elicitation

**Goal:** Gather as much detail as possible about what the user wants to build. No coding.

**Agent behaviour:**

- **Ask questions relentlessly.** Do not proceed until every detail has been explored. It is better to ask too many questions in Stage 1 than to make assumptions that require rework later.
- Drill down into **minutiae**: exact input/output shapes, parameter types, error conditions, pagination, filtering, sorting, and validation rules.
- For every unclear or underspecified requirement, **propose concrete options** and ask the user to choose. Never silently pick an approach — always settle on a common direction with the user.
- Identify what is **in-scope** and what is **out-of-scope**. Be explicit about boundary decisions.
- Surface implicit requirements, edge cases, constraints, security considerations, performance expectations, and acceptance criteria.
- **Do not assume anything.** If something is unclear, ask the user. If the user gives a partial answer, follow up until you have a complete picture.
- For testing, check what scope is expected and what kind of tests are required (propose options: unit, integration, E2E, load, etc.).
- Elicit a link to the work item (e.g., Azure Boards, Jira) that tracks this implementation. If the user cannot provide one, insert `Not provided` into the PRD.
- **Settle on a common approach for every decision point.** Summarize each decision back to the user and wait for explicit confirmation before recording it in the draft PRD.
- Confirm the full understanding with the user — scope, requirements, constraints, testing approach, and decisions — before producing the draft PRD.

**Output:** Draft PRD document placed in `docs/prds/<number>.<sub>-<name>.md` (see [PRD Template](#prd-template-conventions)). The number is assigned when work begins (user specifies it, or the agent proposes the next available). Sub-PRDs use the format `<number>.<sub>` (e.g., `001.01`, `001.02`) to group related but distinct pieces of work under a parent PRD.

**Entry condition:** User describes a feature, fix, or task.
**Exit condition:** Draft PRD is ready for review.
**Transition action:** Update Stage 1 to `✅ Completed` and Stage 2 to `🔄 In Progress` in the PRD tracker, then ask the user to commit the draft PRD.

---

## Stage 2 — Exploration

**Goal:** Understand how the proposed work fits into the existing codebase and create a concrete implementation plan.

**Agent behaviour:**

- Explore relevant existing code, patterns, and conventions.
- Identify which files, classes, and endpoints will need to change.
- Create code examples and prototypes to validate approaches (read-only — no committed changes).
- Define the implementation strategy: what to build first, dependencies, test strategy.
- Expand the draft PRD with technical details: file paths, method signatures, data flows, migration plans, tests to write.

**Output:** Expanded PRD with full technical specification.

**Entry condition:** Draft PRD from Stage 1.
**Exit condition:** PRD contains all technical details needed for implementation.
**Transition action:** Update Stage 2 to `✅ Completed` and Stage 3 to `🔄 In Progress` in the PRD tracker, then ask the user to commit the expanded PRD.

---

## Stage 3 — Validation (User Review)

**Goal:** The user reviews and validates the PRD.

**Agent behaviour:**

- Present the PRD to the user for review.
- Elicit feedback, suggestions, and corrections.
- Incorporate feedback into the PRD.
- Repeat until the user confirms the PRD is finalized.

**Output:** **Finalized PRD** containing all information necessary for correct and efficient implementation.

**Entry condition:** Expanded PRD from Stage 2.
**Exit condition:** User explicitly validates the PRD.
**Transition action:** Update Stage 3 to `✅ Completed` and Stage 4 to `🔄 In Progress` in the PRD tracker, then ask the user to commit the finalized PRD.

---

## Stage 4 — Implementation

**Goal:** Implement the scope defined in the finalized PRD.

**Agent behaviour:**

- Follow the PRD as the single source of truth.
- Write code that adheres to project conventions (see [copilot-instructions.md](../.github/copilot-instructions.md)).
- Write tests alongside implementation.
- Build and run tests after each meaningful change.
- Report progress against the PRD checklist.

**Output:** Working implementation with tests.

**Entry condition:** Finalized PRD from Stage 3.
**Exit condition:** All items in the PRD implementation checklist are complete and passing.
**Transition action:** Update Stage 4 to `✅ Completed` and Stage 5 to `🔄 In Progress` in the PRD tracker, then ask the user to commit the working implementation.

---

## Stage 5 — Validation (Implementation Review)

**Goal:** Validate that the implementation matches the PRD and works correctly.

**Agent behaviour:**

- Review the implementation against the PRD requirements.
- Run all relevant tests (unit, integration).
- Check for lint errors, compile warnings, and nullable violations.
- Identify discrepancies between implementation and PRD.
- Fix any issues found.
- Report back to the user with validation results.
- **DO NOT** update any code

**Output:** Validated implementation or a list of resolved issues.

**Entry condition:** Implementation from Stage 4.
**Exit condition:** All PRD requirements are met and tests pass.
**Transition action:** Update Stage 5 to `✅ Completed` and Stage 6 to `🔄 In Progress` in the PRD tracker, then ask the user to commit the validated implementation.

---

## Stage 6 — Cleanup and Refactoring

**Goal:** Ensure the new implementation is clean, simple, and consistent with project conventions.

**Agent behaviour:**

- Remove dead code, unused imports, and temporary debug statements.
- Ensure naming, formatting, and structure follow project conventions.
- Simplify overly complex code where possible.
- Ensure documentation and comments are clear and accurate.
- Run formatters and linters.

**Output:** Clean, refactored implementation ready for commit.

**Entry condition:** Validated implementation from Stage 5.
**Exit condition:** Code is clean, well-structured, and passes all quality checks.
**Transition action:** Update Stage 6 to `✅ Completed` in the PRD tracker, then ask the user to commit the final clean code.

---

## Stage Transition Procedure

Every time the workflow moves from one stage to the next, the agent MUST:

1. **Update the PRD Stage Tracker** — set the previous stage to `✅ Completed` and the new stage to `🔄 In Progress`.
2. **Ask the user to commit** — prompt the user to commit all current changes to version control before proceeding.
3. **Wait for confirmation** — do not begin the next stage until the user confirms the commit is done.

> **Rationale:** Committing at each stage boundary preserves a clean history and makes it easy to resume interrupted work.

### Stage Transition Checklist

| Transition    | Action                                                      |
| ------------- | ----------------------------------------------------------- |
| Stage 1 → 2   | Update tracker, ask user to commit draft PRD                |
| Stage 2 → 3   | Update tracker, ask user to commit expanded PRD             |
| Stage 3 → 4   | Update tracker, ask user to commit finalized PRD            |
| Stage 4 → 5   | Update tracker, ask user to commit working implementation   |
| Stage 5 → 6   | Update tracker, ask user to commit validated implementation |
| Stage 6 → End | Update tracker, ask user to commit final clean code         |

---

## SDLC Rules

1. **Phase transitions are HARD.** Never skip or merge stages.
2. **The PRD is the single source of truth.** It evolves through Stages 1–3 and becomes the implementation contract in Stage 4.
3. **No coding in Stages 1–3.** Only exploration, planning, and documentation.
4. **The agent MUST adhere to this SDLC** even if the user does not explicitly mention it.
5. **User validation gates progression.** Stages 3→4 and 5→6 require explicit user confirmation.
6. **Commit at every stage boundary.** The user MUST commit changes before the agent proceeds to the next stage.

---

## PRD Template Conventions

PRD files live in `docs/prds/` and follow the naming pattern `<number>.<sub>-<name>.md` (e.g., `001-machine-marking-api.md`, `001.01-marking-validation.md`).

- **Numbering**: The user specifies the PRD number when starting work (e.g., "001", "002"). If not provided, the agent proposes the next available number.
- **Sub-PRDs**: When a feature has multiple distinct but related pieces of work, use sub-PRDs with the format `<number>.<sub>` (e.g., `001.01`, `001.02`). Sub-PRDs reference their parent in the Context section.
- **Sub-PRD suffixes**: The sub number is zero-padded to two digits. A main PRD has no sub-number (just `<number>-<name>.md`).

Use the expanded template at `docs/prds/_template.md` as the starting point. Each PRD MUST include:

| Section                      | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| **SDLC Stage Tracker**       | Table tracking which stages are completed, in progress, or not started |
| **Goal**                     | One-sentence summary of what this feature/task achieves                |
| **Requirements**             | Detailed functional and non-functional requirements                    |
| **Scope**                    | What is explicitly included in this work                               |
| **Out-of-scope**             | What is explicitly excluded                                            |
| **Context**                  | Background, related features, architectural considerations             |
| **Technical Specification**  | Files to create/modify, method signatures, data flows, migration plans |
| **Test Plan**                | Unit tests, integration tests, edge cases to cover                     |
| **Implementation Checklist** | Step-by-step tasks to track during Stage 4                             |
| **Validation Checklist**     | Criteria to verify during Stage 5                                      |

## Phase Quick Reference

```
Stage 1: Requirements Elicitation    → Draft PRD
Stage 2: Exploration                 → Expanded PRD (technical details)
Stage 3: Validation (User Review)    → Finalized PRD
Stage 4: Implementation              → Working code + tests
Stage 5: Validation (Implementation) → Verified against PRD
Stage 6: Cleanup & Refactoring       → Clean, production-ready code
```
