import type { BuiltinSkill } from "../types"

export const mergeWorkflowSkill: BuiltinSkill = {
  name: "merge-workflow",
  description:
    "Git merge workflow for feature/hotfix branches with CI verification. Use when merging develop/master into feature branches, resolving merge conflicts, or executing two-phase merge strategies (pre-fix merge + post-green merge). Trigger: 'merge develop', 'merge master', 'merge conflict', 'integrate branch', 'hotfix merge'.",
  template: `# Merge Workflow Skill

Systematic git merge workflow for long-lived feature and hotfix branches.

## Pre-Merge Checklist

1. **Clean working tree** — commit or stash all changes before merging
   \`\`\`bash
   git status
   # If dirty: git stash -m "pre-merge stash" OR commit pending changes
   \`\`\`

2. **Fetch latest remote state**
   \`\`\`bash
   git fetch origin
   git log --oneline -3 origin/develop  # see what's coming
   \`\`\`

3. **Check divergence**
   \`\`\`bash
   git rev-list --count HEAD..origin/develop   # commits behind
   git rev-list --count origin/develop..HEAD    # commits ahead
   \`\`\`

## Merge Execution

### Standard Merge (always merge, never rebase for shared branches)
\`\`\`bash
git merge origin/develop
# If conflicts → resolve → git add → git commit
# If clean → auto-commit created
\`\`\`

### Conflict Resolution Strategy

| File Type | Prefer | Reason |
|-----------|--------|--------|
| Application source (.cs, .ts, .js) | develop | Keep app code current |
| Test files (E2E, unit) | hotfix/feature | Preserve test work |
| Build scripts (.ps1, .targets) | MANUAL | Check for structural conflicts |
| Config files (.json, .xml) | MANUAL | Both sides may have valid changes |
| Package files (*.csproj, package.json) | MANUAL | Merge dependencies carefully |

### Conflict Resolution Process
1. \`git diff --name-only --diff-filter=U\` — list conflicted files
2. For each file: read conflict markers, understand both sides
3. Apply resolution strategy per file type
4. After resolution: \`git add {file}\` for each resolved file
5. \`git commit\` — use auto-generated merge message

### Post-Merge Validation
\`\`\`bash
# Verify merge commit
git log --oneline -1  # should show "Merge branch..."

# Build immediately
dotnet build {Solution}.sln --nologo  # .NET
# or: npm run build / pnpm build      # Node.js

# Run quick smoke test
dotnet test --filter "ClassName~SmokeTest" --nologo  # if available
\`\`\`

## Two-Phase Merge Pattern

For hotfix branches requiring CI green verification:

### Phase 1: Pre-Fix Merge
1. Merge develop BEFORE starting fix work
2. Resolve conflicts
3. Build and verify compilation
4. Push and capture CI baseline
5. This becomes the new starting point for all fix work

### Phase 2: Post-Green Merge (after CI is green)
1. After achieving green CI on Phase 1 fixes
2. Merge develop AGAIN (absorb any new develop changes)
3. Resolve any new conflicts
4. Build and verify locally
5. Push and verify CI is green AGAIN
6. Only then is the branch ready for release

\`\`\`
Phase 1: merge develop → fix all tests → push → CI green ✓
Phase 2: merge develop AGAIN → local verify → push → CI green ✓✓
Result: Branch is current with develop AND green
\`\`\`

## Handling Stashed Changes

If you stashed changes pre-merge:
\`\`\`bash
git stash list                    # find your stash
git stash show -p stash@{0}      # preview what will be applied
git stash pop                    # apply and drop stash
# If pop conflicts: resolve, then git stash drop stash@{0}
\`\`\`

## Merge Failure Recovery

### Build Fails After Merge
1. Check for duplicated elements in .csproj/.targets files
2. Check for conflicting using statements
3. Check for duplicated method names (both sides added same-named method)
4. Fix → commit as separate "fix merge" commit

### Tests Fail After Merge
1. This is EXPECTED — it's the new baseline
2. Record all failures as post-merge baseline
3. Don't blame the merge — classify each failure independently
4. Some failures may be new from develop, some may be pre-existing

## Commit Messages

- Merge commit: \`merge: integrate develop into {branch}\`
- Post-green merge: \`merge: integrate develop into {branch} (post-green)\`
- Merge fix: \`fix(merge): resolve {issue} after develop merge [{TASK_KEY}]\`
`,
}
