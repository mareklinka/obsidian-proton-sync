---
name: prd-review
user-invocable: true
description: '**REVIEW SKILL** — Critique a PRD as an expert software engineer/architect, identifying gaps, blind spots, and risks. USE FOR: reviewing PRDs before implementation, finding missing requirements, edge cases, security concerns, performance implications, or implementation risks. Trigger when asked to review, critique, audit, or validate a PRD. DO NOT USE FOR: writing new PRDs (use requirements-elicitation), implementing features (use implementation workflow), or testing code. INVOKES: file system tools (read PRD), codebase exploration (validate technical feasibility), ask-questions tool (clarify ambiguities with user).'
---

# PRD Review Skill

## Purpose

Act as an expert software engineer and architect to critically review a Product Requirements Document (PRD) before implementation begins. Identify gaps, blind spots, edge cases, and risks that could cause rework, security issues, or implementation failures.

## When to Use

- User asks to review, critique, audit, or validate a PRD
- SDLC Stage 3 (Validation) is complete and user wants a pre-implementation check
- User says "review this PRD", "critique the PRD", "find gaps", "what's missing", "is this complete"

## Review Process

### 1. Read and Understand

- Load the PRD file (typically in `docs/prds/`)
- Understand the goal, requirements, scope, and technical specification
- Check if the PRD follows the project's SDLC structure

### 2. Structural Review

- Verify all required sections are present:
  - Goal
  - Functional Requirements
  - Non-Functional Requirements
  - Scope (In-Scope / Out-of-Scope)
  - Context (Related PRDs, Existing Infrastructure)
  - Technical Specification (Files to Create/Modify, Data Flow, DI Registration)
  - Test Plan
  - Implementation Checklist
  - Validation Checklist
- Check for consistency between sections (e.g., route paths match in Technical Spec and Data Flow)

### 3. Requirements Analysis

#### Functional Requirements

- **Completeness**: Are all user-facing behaviors documented?
- **Edge Cases**: What happens with invalid input, empty data, concurrent access?
- **Business Rules**: Are all validation rules explicit? Are they testable?
- **Error Handling**: Are all error scenarios documented with specific HTTP status codes and response shapes?
- **Data Flow**: Is the data flow clear and complete? Are there missing transformation steps?

#### Non-Functional Requirements

- **Performance**: Are there performance implications (N+1 queries, large payloads, streaming)?
- **Security**: Are there authentication/authorization gaps? Are sensitive data handled correctly?
- **Scalability**: Will this work with 100x more data?
- **Reliability**: Are there retry, timeout, or circuit-breaker considerations?
- **Observability**: Are there logging, tracing, or monitoring requirements?

### 4. Technical Feasibility Check

#### Codebase Alignment

- Do the proposed files/classes exist or need to be created?
- Are the proposed patterns consistent with existing code?
- Are the proposed dependencies already registered in DI?
- Are there circular dependencies or architectural violations?

#### Database Considerations

- Are there new tables, columns, or indexes needed?
- Are there migration considerations?
- Are there unique constraint conflicts?
- Are there foreign key relationships that need to be enforced?

#### API Design

- Are request/response shapes consistent with existing endpoints?
- Are there versioning considerations?
- Are there pagination, filtering, or sorting needs not documented?
- Are there rate-limiting or throttling considerations?

### 5. Test Plan Review

#### Coverage

- Are there tests for all functional requirements?
- Are there tests for edge cases and error scenarios?
- Are there tests for non-functional requirements (performance, security)?
- Are there tests for authorization and licensing?

#### Test Quality

- Are test scenarios specific and actionable?
- Are expected outcomes clearly defined?
- Are there tests that verify negative scenarios (what should NOT happen)?

### 6. Risk Assessment

#### Implementation Risks

- Are there dependencies on untested or unstable components?
- Are there known limitations in the existing infrastructure?
- Are there timing or sequencing issues (e.g., migration order, DI registration order)?

#### Business Risks

- Are there compliance or regulatory considerations?
- Are there backward compatibility issues?
- Are there user experience implications not documented?

#### Operational Risks

- Are there deployment considerations (feature flags, gradual rollout)?
- Are there monitoring or alerting needs?
- Are there rollback strategies if something goes wrong?

### 7. Output Format

Produce a structured review report with:

#### Critical Issues (Must Fix Before Implementation)

- Missing requirements that would cause implementation failures
- Security vulnerabilities or authorization gaps
- Data integrity risks (partial updates, race conditions)
- Architectural violations

#### Warnings (Should Address)

- Missing edge case handling
- Performance implications
- Test coverage gaps
- Inconsistencies between sections

#### Suggestions (Nice to Have)

- Additional validation or error handling
- Better documentation or clarity
- Future-proofing considerations
- Observability improvements

#### Questions for User

- Ambiguities that need clarification
- Decisions that require user input
- Trade-offs that need to be made

## Review Checklist

Use this checklist during review:

- [ ] All functional requirements are testable
- [ ] All error scenarios are documented
- [ ] Authorization and licensing are correctly specified
- [ ] Data flow is complete and consistent
- [ ] Database changes are accounted for
- [ ] Test plan covers all requirements
- [ ] No architectural violations
- [ ] No security gaps
- [ ] No performance risks unaddressed
- [ ] Implementation is feasible with existing infrastructure

## Example Prompts

- "Review PRD 001.05 for gaps and blind spots"
- "Critique this PRD before I start implementing"
- "What's missing from this PRD?"
- "Is this PRD complete enough to implement?"
- "Find risks in this PRD"

## Quality Criteria

A good PRD review should:

- Identify at least 3-5 issues (if none found, question whether review was thorough)
- Distinguish between critical, warning, and suggestion-level issues
- Provide specific, actionable recommendations
- Reference existing code patterns when applicable
- Ask clarifying questions when ambiguities are found
