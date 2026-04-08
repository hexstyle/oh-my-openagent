Use shell commands as if no human will ever see or answer them live.

Rules:

- Prefer non-interactive flags such as `-y`, `--yes`, `--no-edit`, `--no-input`, `--force`, and `--batch` when they are appropriate.
- Never launch terminal editors or pagers from the shell. Avoid `vim`, `vi`, `nano`, `less`, `more`, `man`, and REPL-style commands that wait for input.
- Prefer direct file tools over shell text munging when editing repository files.
- Avoid interactive git modes such as `git add -p`, `git rebase -i`, and plain `git commit` without `-m`.
- Use explicit SSH batch settings and non-interactive unzip/install flags when commands could otherwise prompt.
- If a command might block on confirmation, rewrite it before running it.
- If a command still hangs unexpectedly, stop it quickly and switch to a non-interactive form instead of waiting.
