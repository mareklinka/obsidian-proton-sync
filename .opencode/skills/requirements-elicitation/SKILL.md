---
name: requirements-elicitation
description: 'Elicit and formalize requirements for a feature or implementation. Trigger when a user describes any new feature, enhancement, bug fix, task, or idea — even informally or vaguely. Use when scope, boundaries, or acceptance criteria are unclear, when the user says "I want to add…", "we need…", "can we…", "what about…", or mentions planning/scoping before coding. Iteratively asks clarifying questions until a common understanding with the user is reached. Produces a structured PRD in docs/prds/.'
argument-hint: 'Describe the feature, task, or idea you want to implement'
---

# Requirements Elicitation Skill

## When to Use

- A user describes a feature, enhancement, bug fix, or any development task
- Scope, boundaries, or requirements are unclear or need formalization
- Starting **Stage 1** of the SDLC workflow (see [docs/sdlc.md](../../sdlc.md))
- Before any exploration or implementation begins
- User says any of: "I want to add…", "we need…", "can we…", "what about…", "let's build…", "help me plan…", "I have an idea for…", "before we code…"
- User mentions planning, scoping, defining, spec'ing, or outlining before implementation

## Procedure

### Step 1 — Initial Assessment

1. Read the user's description of the desired work.
2. Identify what is clear and what is missing.
3. Produce a **first draft** of clarifying questions covering:
   - **Goal**: What problem does this solve? What does success look like?
   - **Scope**: What is in-scope? What is explicitly out-of-scope?
   - **Users**: Who will use this? What roles/perspectives matter?
   - **Data**: What data is affected? New entities? Existing records?
   - **Integration**: Does this touch existing features, APIs, services, or devices?
   - **Constraints**: Performance, security, licensing (ONPREM vs Azure), platform differences?
   - **Edge cases**: Error scenarios, empty states, invalid input, concurrent access?
   - **Validation**: How will the user know this is done correctly? Acceptance criteria?

### Step 2 — Iterative Clarification

1. Present the initial questions to the user in a structured, digestible format.
2. Listen carefully to answers — each answer may reveal new questions.
3. Ask follow-up questions iteratively until:
   - All major dimensions (goal, scope, data, integration, constraints, validation) are covered.
   - Ambiguities are resolved.
   - The user confirms understanding is aligned.
4. **Do not assume** — if something is unclear, ask. If the user says "just follow existing patterns," ask which patterns and which files to reference.

### Step 3 — Draft PRD

1. Synthesize all gathered information into a PRD using the template at `docs/prds/_template.md`.
2. Place the file as `docs/prds/<number>-<name>.md` (use the next sequential number).
3. Fill every section:
   - **Goal** — one-sentence summary
   - **Requirements** — numbered, specific, testable statements
   - **Scope** — explicit inclusions
   - **Out-of-scope** — explicit exclusions (prevents scope creep)
   - **Context** — related features, architectural notes
   - **Technical Specification** — placeholder (to be expanded in Stage 2)
   - **Test Plan** — placeholder (to be expanded in Stage 2)
   - **Implementation Checklist** — placeholder (to be expanded in Stage 2)
   - **Validation Checklist** — placeholder (to be expanded in Stage 2)
4. Present the draft PRD to the user.

### Step 4 — Review and Refine

1. Ask the user to review the draft PRD.
2. Incorporate feedback — update scope, add missing requirements, correct misunderstandings.
3. Repeat until the user confirms the PRD accurately represents their intent.

### Step 5 — Handoff

1. Confirm with the user that requirements elicitation is complete.
2. State clearly: _"Requirements elicitation is complete. The PRD is ready for the Exploration stage (Stage 2)."_
3. Do **not** proceed to exploration or implementation without explicit user confirmation.

## Decision Points

| Situation                                     | Action                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| User provides vague description               | Ask targeted questions to narrow scope before drafting                              |
| User says "I don't know yet"                  | Suggest options based on existing patterns; ask them to pick                        |
| Multiple unrelated features in one request    | Split into separate PRDs; handle one at a time                                      |
| User is unsure about technical boundaries     | Note as "to be explored" and flag for Stage 2 — do not guess                        |
| Licensing/platform constraints (ONPREM/Azure) | Always ask if the feature affects licensed endpoints or platform-specific behaviour |
| Data model changes                            | Always ask about existing data, migrations, backward compatibility                  |

## Quality Criteria

The elicitation is complete when:

- [ ] Goal is stated in one clear sentence
- [ ] Requirements are specific, unambiguous, and numbered
- [ ] Scope and out-of-scope are both explicitly defined
- [ ] All identified integration points are noted
- [ ] Constraints (licensing, platform, performance) are documented
- [ ] User has reviewed and confirmed the PRD
- [ ] PRD file exists in `docs/prds/` with correct naming

## Anti-patterns to Avoid

- **Do not** start coding or even exploring code during this stage.
- **Do not** skip questions because "it seems obvious" — always confirm.
- **Do not** fill Technical Specification, Test Plan, or Implementation Checklist — those are Stage 2 work.
- **Do not** merge this stage with Exploration — hard transition per SDLC.
- **Do not** assume platform (ONPREM vs Azure) — always ask.
