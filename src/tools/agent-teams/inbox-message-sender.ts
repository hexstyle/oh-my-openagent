import { randomUUID } from "node:crypto"
import { InboxMessageSchema } from "./types"
import { appendInboxMessage } from "./inbox-store"

function nowIso(): string {
  return new Date().toISOString()
}

const STRUCTURED_TYPE_MAP: Record<string, string> = {
  shutdown_request: "shutdown_request",
  shutdown_approved: "shutdown_response",
  shutdown_rejected: "shutdown_response",
  plan_approved: "plan_approval_response",
  plan_rejected: "plan_approval_response",
}

export function buildShutdownRequestId(recipient: string): string {
  return `shutdown-${recipient}-${randomUUID().slice(0, 8)}`
}

export function sendPlainInboxMessage(
  teamName: string,
  sender: string,
  recipient: string,
  content: string,
  summary: string,
  _color?: string,
): void {
  const message = InboxMessageSchema.parse({
    id: randomUUID(),
    type: "message",
    sender,
    recipient,
    content,
    summary,
    timestamp: nowIso(),
    read: false,
  })
  appendInboxMessage(teamName, recipient, message)
}

export function sendStructuredInboxMessage(
  teamName: string,
  sender: string,
  recipient: string,
  data: Record<string, unknown>,
  summaryType: string,
): void {
  const messageType = STRUCTURED_TYPE_MAP[summaryType] ?? "message"
  const message = InboxMessageSchema.parse({
    id: randomUUID(),
    type: messageType,
    sender,
    recipient,
    content: JSON.stringify(data),
    summary: summaryType,
    timestamp: nowIso(),
    read: false,
  })
  appendInboxMessage(teamName, recipient, message)
}
