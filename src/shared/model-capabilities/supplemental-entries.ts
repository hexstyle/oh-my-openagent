import type { ModelCapabilitiesSnapshotEntry } from "./types"

export const SUPPLEMENTAL_MODEL_CAPABILITIES: Record<string, ModelCapabilitiesSnapshotEntry> = {
	"gpt-5.4-mini-fast": {
		id: "gpt-5.4-mini-fast",
		family: "gpt-mini",
		reasoning: true,
		temperature: false,
		toolCall: true,
		modalities: {
			input: ["text", "image"],
			output: ["text"],
		},
		limit: {
			context: 400000,
			input: 272000,
			output: 128000,
		},
	},
	"anthropic/claude-opus-4-7": {
		id: "anthropic/claude-opus-4-7",
		family: "claude-opus",
		reasoning: true,
		temperature: true,
		toolCall: true,
		modalities: {
			input: ["text", "image", "pdf"],
			output: ["text"],
		},
		limit: {
			context: 1000000,
			input: 1000000,
			output: 128000,
		},
	},
}
