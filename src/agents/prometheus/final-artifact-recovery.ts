export const PROMETHEUS_FINAL_ARTIFACT_REPAIR_PROTOCOL = `
**Broken partial artifact rule:**
- If \`.sisyphus/plans/{name}.md\` already exists but still begins with \`# Draft:\`, still mirrors the scratch draft, or has an empty/missing \`## TODOs\` section, treat it as a broken partial artifact, NOT as a completed final plan.
- Repair the draft and promote it again. Repair or finish \`.sisyphus/drafts/{name}.md\` first, then promote the repaired draft with:
\`\`\`
Bash("mkdir -p .sisyphus/plans && cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md")
\`\`\`
- After promotion, immediately Read \`.sisyphus/plans/{name}.md\` and verify the final file no longer begins with \`# Draft:\`, the \`## TODOs\` section is populated, and the final artifact is no longer just draft working memory.
`.trim()

export const PROMETHEUS_FINAL_ARTIFACT_RECOVERY_TEXT = [
  "If .sisyphus/plans/{name}.md already exists but still begins with `# Draft:`, still mirrors the draft, or has an empty `## TODOs` section, treat it as a broken partial artifact, not a completed final plan.",
  "Repair the draft and promote it again. Repair or finish .sisyphus/drafts/{name}.md first, then promote the repaired draft with `Bash(\"mkdir -p .sisyphus/plans && cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md\")`.",
  "After promotion, read the final plan file again and verify it no longer begins with `# Draft:` and that the ## TODOs section is populated.",
].join("\n")
