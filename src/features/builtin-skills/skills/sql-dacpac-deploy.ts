import type { BuiltinSkill } from "../types"

export const sqlDacpacDeploySkill: BuiltinSkill = {
  name: "sql-dacpac-deploy",
  description:
    "SQL Server DACPAC deployment and SSDT project expertise. Use when working with .sqlproj files, DACPAC publish profiles, SQL migration scripts, SQL72014 errors, or database deployment in CI. Trigger: 'sqlproj', 'DACPAC', 'SQL72014', 'DeployDataDatabase', 'SQL migration', 'post-deploy script'.",
  template: `# SQL DACPAC Deploy Skill

Expert knowledge for SQL Server Data-Tier Applications (DACPAC) in CI/CD pipelines.

## SSDT Project Structure

\`\`\`
OptimizerData/
├── OptimizerData.sqlproj          # SSDT project file
├── Scripts/
│   ├── OPTIEX-XXXX-pre.sql        # Pre-deployment scripts (run before schema diff)
│   └── OPTIEX-XXXX-post.sql       # Post-deployment scripts (run after schema diff)
├── Tables/
│   └── dbo.TableName.sql          # Table definitions (schema source of truth)
├── Views/
├── StoredProcedures/
└── Publish/
    └── profile.publish.xml         # Deployment profile
\`\`\`

## Common SQL72014 Error Pattern

\`\`\`
SQL72014: .Net SqlClient Data Provider: Msg 207, Level 16, State 1, Line N
Invalid column name 'ColumnName'
\`\`\`

**Root cause**: Pre/post-deployment script references a column that doesn't exist in the
target database yet (or was already dropped). SSDT validates SQL at compile time.

**Fixes** (choose based on situation):

### Fix 1: Guard with EXISTS check
\`\`\`sql
IF EXISTS (SELECT 1 FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    WHERE t.name = 'TableName' AND c.name = 'ColumnName')
BEGIN
    -- your INSERT/UPDATE/DELETE here
END
\`\`\`

### Fix 2: Wrap in sp_executesql (deferred validation)
\`\`\`sql
EXEC sp_executesql N'
    INSERT INTO TableName (Col1, Col2, Col3)
    SELECT Col1, Col2, Col3 FROM SourceTable;
';
\`\`\`
This prevents compile-time column validation — SQL Server only validates at execution time.

### Fix 3: Combine EXISTS + sp_executesql (safest)
\`\`\`sql
IF EXISTS (SELECT 1 FROM sys.columns c
    JOIN sys.tables t ON c.object_id = t.object_id
    WHERE t.name = 'TargetTable' AND c.name = 'RequiredColumn')
BEGIN
    EXEC sp_executesql N'
        INSERT INTO TargetTable (RequiredColumn, OtherCol)
        SELECT RequiredColumn, OtherCol FROM SourceTable;
    ';
END
\`\`\`

## DACPAC Deployment in CI

Typical Bamboo/CI flow:
1. \`dotnet build *.sqlproj\` — builds DACPAC from schema + scripts
2. Deploy step applies DACPAC to target database
3. Pre-deployment scripts run BEFORE schema diff
4. Schema diff is calculated and applied
5. Post-deployment scripts run AFTER schema diff

**Key insight**: If a post-deploy script references columns added by the schema diff,
the script is valid at runtime. But SSDT may still validate it at BUILD time and fail
with SQL72014. That's why \`sp_executesql\` is needed — it defers validation.

## Merge Conflicts in SQL Scripts

After merging develop:
1. Check for duplicated migration scripts (same OPTIEX-XXXX number, different content)
2. Check post-deploy script ordering (scripts run alphabetically by default)
3. Verify table definitions haven't diverged (column added in both branches)
4. Rebuild: \`dotnet build *.sqlproj --nologo\`

## Debug SQL Deployment Failures in CI Logs

Look for these patterns in build logs:
- \`SQL72014\` — Invalid column/table reference (fix: EXISTS guard + sp_executesql)
- \`SQL72045\` — Script execution error (fix: check script syntax)
- \`MSB4038\` — XML ordering error in .targets (fix: check Target block order)
- \`Deploy data database failed with exit code 1\` — deployment failed (read preceding errors)
`,
}
