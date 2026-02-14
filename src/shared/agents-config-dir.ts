import { homedir } from "node:os"
import { join } from "node:path"

export function getAgentsConfigDir(): string {
  return join(homedir(), ".agents")
}
