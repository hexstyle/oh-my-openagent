---
name: naming-review
description: "Review method, variable, class, file, commit, and PR naming for precision and brevity. Use when code review reveals vague, stale, misleading, or overly long names, when page/object names do not match the actual screen or role, or when preparing commits/PRs for push. Triggers: 'naming review', 'review naming', 'variable names are bad', 'method naming', 'bad naming', 'commit naming', 'PR title naming'."
---

# Naming Review

Use this skill when reviewing or correcting names in code and delivery artifacts.

## Core rule

Every name must be:
- short enough to scan quickly
- specific enough to reflect the real role
- consistent with the current behavior, not old history

If a name is technically valid but suggests the wrong concept, it is bad.

Example:
- entering the home page and storing it as `adminPage` is wrong unless it is actually an admin page
- after a refactor, stale names like `legacyResult`, `tempValue`, `newData`, `result2` should usually be replaced

## What to check in code

Review these surfaces:
- local variables
- method and function names
- class, type, and interface names
- page object names
- test names
- helper file names when they expose a concept

Flag names that are:
- misleading
- too generic
- too long
- stale after refactor
- role-mismatched
- overloaded with implementation noise

## Naming rules

### Variables

Prefer names that reflect the actual object or value:
- `homePage` over `adminPage` if the page is the home page
- `buildLog` over `data`
- `failedTests` over `items`

Avoid:
- `data`
- `obj`
- `item`
- `temp`
- `value`
- `result2`
- `newSomething`
- `actualPage` when a real page role exists

Collections should usually be plural:
- `tests`
- `errors`
- `sessions`

Booleans should read like predicates:
- `isReady`
- `hasFailures`
- `canRetry`
- `shouldRebuild`

### Methods and functions

Names should describe the observable action, not internal mechanics.

Prefer:
- `loadBuildLog`
- `collectFailedTests`
- `retrySyncPrompt`
- `removeDuplicateDeployBlocks`

Avoid:
- `doStuff`
- `handle`
- `processData`
- `executeImpl`
- `fixThings`

If a method both checks and mutates, split it or name the mutation explicitly.

### Tests

Test names should describe the user-visible or system-visible behavior.

Prefer:
- `showsIncotermsRowAfterSave`
- `removesDeletedRowFromGrid`
- `fallsBackToSameModelAfterTransient403`

Avoid names that only mirror implementation:
- `callsHelperWhenFlagIsTrue`
- `usesMethodX`

## Review heuristics

When evaluating a name, ask:
1. If I only read the name, would I predict the right behavior?
2. Would another reviewer infer the same domain meaning?
3. Is the name still correct after the latest refactor?
4. Can I shorten it without losing meaning?

If the answer to 1 or 2 is no, rename it.

## Delivery artifact naming

When naming commits or PR titles:
- include what was done
- keep it concise
- avoid decorative text

If pushing anywhere except the official GitHub remote, task number is mandatory.

Examples:
- `fix(ci): resolve Deploy target merge duplication [OPTIEX-4797]`
- `feat(playwright): close TC_EX_0470 parity gap [OPTIEX-4797]`
- `docs(playwright): refresh parity matrix [OPTIEX-4797]`

Bad examples:
- `misc changes`
- `updates`
- `fix stuff`
- `Ultraworked with Sisyphus`
- `Co-authored-by: Sisyphus <...>`

Never include AI attribution or co-authorship boilerplate in commit text or PR title:
- `Sisyphus`
- `OpenCode`
- `OpenAgent`
- `Opencode`
- `Ultraworked with ...`
- `Co-authored-by: ...`

## Suggested review output

When reporting naming issues, use:

`Current name -> Proposed name: why the current name is misleading`

Examples:
- `adminPage -> homePage: variable points to the landing page, not an admin-only screen`
- `data -> buildLog: value stores Bamboo log text, not arbitrary data`
- `handleResult -> collectFailedTests: method extracts failures and does not just "handle" a result`

## Default stance

Do not keep a bad name just because it already exists.
Do not make names longer than necessary in the name of "clarity".
Choose the shortest name that still points to the correct domain concept.
