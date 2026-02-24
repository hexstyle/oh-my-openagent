import { existsSync } from "node:fs"

const DEFAULT_ZSH_PATHS = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]
const DEFAULT_BASH_PATHS = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]
const DEFAULT_WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe"

function findShellPath(
	defaultPaths: string[],
	customPath?: string,
): string | null {
	if (customPath && existsSync(customPath)) {
		return customPath
	}
	for (const path of defaultPaths) {
		if (existsSync(path)) {
			return path
		}
	}
	return null
}

export function findZshPath(customZshPath?: string): string | null {
  if (process.platform === "win32") {
    return process.env.COMSPEC?.trim() || DEFAULT_WINDOWS_CMD_PATH
  }

	return findShellPath(DEFAULT_ZSH_PATHS, customZshPath)
}

export function findBashPath(): string | null {
  if (process.platform === "win32") {
    return process.env.COMSPEC?.trim() || DEFAULT_WINDOWS_CMD_PATH
  }

	return findShellPath(DEFAULT_BASH_PATHS)
}
