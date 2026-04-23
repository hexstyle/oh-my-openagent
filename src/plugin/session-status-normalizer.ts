type EventInput = { event: { type: string; properties?: Record<string, unknown> } }
type SessionStatus = { type: string }

function getSessionID(props: Record<string, unknown>): string | undefined {
	if (typeof props.sessionID === "string" && props.sessionID.length > 0) return props.sessionID
	if (typeof props.sessionId === "string" && props.sessionId.length > 0) return props.sessionId

	const info = props.info
	if (typeof info !== "object" || info === null) return undefined
	if (typeof (info as Record<string, unknown>).sessionID === "string") {
		return (info as Record<string, unknown>).sessionID as string
	}
	if (typeof (info as Record<string, unknown>).sessionId === "string") {
		return (info as Record<string, unknown>).sessionId as string
	}
	if (typeof (info as Record<string, unknown>).id === "string") {
		return (info as Record<string, unknown>).id as string
	}

	return undefined
}

export function normalizeSessionStatusToIdle(input: EventInput): EventInput | null {
	if (input.event.type !== "session.status") return null

	const props = input.event.properties
	if (!props) return null

	const status = props.status as SessionStatus | undefined
	if (!status || status.type !== "idle") return null

	const sessionID = getSessionID(props)
	if (!sessionID) return null

	return {
		event: {
			type: "session.idle",
			properties: { sessionID },
		},
	}
}
