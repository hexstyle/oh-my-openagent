#!/usr/bin/env bun

import { appendFileSync, readFileSync } from "node:fs"
import { createOpencodeClient } from "@opencode-ai/sdk"

import { buildRetryModelPayload } from "../src/hooks/runtime-fallback/retry-model-payload"

function appendLog(logPath: string, message: string): void {
  try {
    appendFileSync(logPath, `${message}\n`)
  } catch {
  }
}

function readToken(tokenPath: string): string {
  try {
    return readFileSync(tokenPath, "utf-8").trim()
  } catch {
    return ""
  }
}

async function main(): Promise<void> {
  const [
    sleepSecondsRaw = "0",
    tokenPath = "",
    expectedToken = "",
    sessionID = "",
    sessionDirectory = process.cwd(),
    serverBaseUrl = "",
    nextModel = "",
    modelVariant = "",
    agentName = "",
    promptText = "",
    logPath = "",
  ] = process.argv.slice(2)

  const sleepMs = Math.max(0, Number.parseInt(sleepSecondsRaw, 10) || 0) * 1000
  if (sleepMs > 0) {
    await Bun.sleep(sleepMs)
  }

  if (readToken(tokenPath) !== expectedToken) {
    process.exit(0)
  }

  const retryPayload = buildRetryModelPayload(
    modelVariant ? `${nextModel}(${modelVariant})` : nextModel,
  )
  if (!retryPayload) {
    appendLog(logPath, `[${new Date().toISOString()}] [runtime-fallback external] invalid model payload: ${nextModel}`)
    process.exit(1)
  }

  appendLog(
    logPath,
    `[${new Date().toISOString()}] [runtime-fallback external] firing session=${sessionID} model=${nextModel} variant=${modelVariant} agent=${agentName}`,
  )

  const client = createOpencodeClient({
    baseUrl: serverBaseUrl,
    directory: sessionDirectory,
  })

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(agentName ? { agent: agentName } : {}),
        ...retryPayload,
        parts: [{ type: "text", text: promptText }],
      },
      query: { directory: sessionDirectory },
    })
  } catch (error) {
    appendLog(
      logPath,
      `[${new Date().toISOString()}] [runtime-fallback external] promptAsync failed: ${String(error)}`,
    )
    process.exit(1)
  }
}

await main()
