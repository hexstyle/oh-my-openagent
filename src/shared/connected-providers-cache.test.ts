/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	createConnectedProvidersCacheStore,
	findProviderModelMetadata,
} from "./connected-providers-cache"
import * as logger from "./logger"

let fakeUserCacheRoot = ""
let testCacheDir = ""
let testCacheStore: ReturnType<typeof createConnectedProvidersCacheStore>

describe("updateConnectedProvidersCache", () => {
	beforeEach(() => {
		fakeUserCacheRoot = mkdtempSync(join(tmpdir(), "connected-providers-user-cache-"))
		testCacheDir = join(fakeUserCacheRoot, "oh-my-opencode")
		testCacheStore = createConnectedProvidersCacheStore(() => testCacheDir)
	})

	afterEach(() => {
		if (existsSync(fakeUserCacheRoot)) {
			rmSync(fakeUserCacheRoot, { recursive: true, force: true })
		}
		fakeUserCacheRoot = ""
		testCacheDir = ""
	})

	test("extracts models from provider.list().all response", async () => {
		//#given
		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["openai", "anthropic"],
						all: [
							{
								id: "openai",
								name: "OpenAI",
								env: [],
								models: {
									"gpt-5.3-codex": { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
									"gpt-5.4": { id: "gpt-5.4", name: "GPT-5.4" },
								},
							},
							{
								id: "anthropic",
								name: "Anthropic",
								env: [],
								models: {
									"claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
									"claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
								},
							},
						],
					},
				}),
			},
		}

		//#when
		await testCacheStore.updateConnectedProvidersCache(mockClient)

		//#then
		const cache = testCacheStore.readProviderModelsCache()
		expect(cache).not.toBeNull()
		expect(cache!.connected).toEqual(["openai", "anthropic"])
		expect(cache!.models).toEqual({
			openai: [
				{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
				{ id: "gpt-5.4", name: "GPT-5.4" },
			],
			anthropic: [
				{ id: "claude-opus-4-6", name: "Claude Opus 4.6" },
				{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
			],
		})
	})

	test("writes empty models when provider has no models", async () => {
		//#given
		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["empty-provider"],
						all: [
							{
								id: "empty-provider",
								name: "Empty",
								env: [],
								models: {},
							},
						],
					},
				}),
			},
		}

		//#when
		await testCacheStore.updateConnectedProvidersCache(mockClient)

		//#then
		const cache = testCacheStore.readProviderModelsCache()
		expect(cache).not.toBeNull()
		expect(cache!.models).toEqual({})
	})

	test("writes empty models when all field is missing", async () => {
		//#given
		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["openai"],
					},
				}),
			},
		}

		//#when
		await testCacheStore.updateConnectedProvidersCache(mockClient)

		//#then
		const cache = testCacheStore.readProviderModelsCache()
		expect(cache).not.toBeNull()
		expect(cache!.models).toEqual({})
	})

	test("does nothing when client.provider.list is not available", async () => {
		//#given
		const mockClient = {}

		//#when
		await testCacheStore.updateConnectedProvidersCache(mockClient)

		//#then
		const cache = testCacheStore.readProviderModelsCache()
		expect(cache).toBeNull()
	})

	test("does not log when connected-providers cache file is simply missing", () => {
		const logSpy = spyOn(logger, "log").mockImplementation(() => {})

		expect(testCacheStore.readConnectedProvidersCache()).toBeNull()
		expect(logSpy).not.toHaveBeenCalled()

		logSpy.mockRestore()
	})

	test("does not log when provider-models cache file is simply missing", () => {
		const logSpy = spyOn(logger, "log").mockImplementation(() => {})

		expect(testCacheStore.readProviderModelsCache()).toBeNull()
		expect(logSpy).not.toHaveBeenCalled()

		logSpy.mockRestore()
	})

	test("still logs when connected-providers cache exists but cannot be parsed", () => {
		const logSpy = spyOn(logger, "log").mockImplementation(() => {})
		mkdirSync(testCacheDir, { recursive: true })
		writeFileSync(join(testCacheDir, "connected-providers.json"), "{not-json")

		expect(testCacheStore.readConnectedProvidersCache()).toBeNull()
		expect(logSpy).toHaveBeenCalledWith(
			"[connected-providers-cache] Error reading cache",
			expect.objectContaining({
				cacheFile: join(testCacheDir, "connected-providers.json"),
				error: expect.any(String),
			}),
		)

		logSpy.mockRestore()
	})

	test("still logs when provider-models cache exists but cannot be parsed", () => {
		const logSpy = spyOn(logger, "log").mockImplementation(() => {})
		mkdirSync(testCacheDir, { recursive: true })
		writeFileSync(join(testCacheDir, "provider-models.json"), "{not-json")

		expect(testCacheStore.readProviderModelsCache()).toBeNull()
		expect(logSpy).toHaveBeenCalledWith(
			"[connected-providers-cache] Error reading provider-models cache",
			expect.objectContaining({
				cacheFile: join(testCacheDir, "provider-models.json"),
				error: expect.any(String),
			}),
		)

		logSpy.mockRestore()
	})

	test("does not remove unrelated files in the cache directory", async () => {
		//#given
		const realCacheDir = join(fakeUserCacheRoot, "oh-my-opencode")
		const sentinelPath = join(realCacheDir, "connected-providers-cache.test-sentinel.json")
		mkdirSync(realCacheDir, { recursive: true })
		writeFileSync(sentinelPath, JSON.stringify({ keep: true }))

		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["openai"],
						all: [
							{
								id: "openai",
								models: {
									"gpt-5.4": { id: "gpt-5.4" },
								},
							},
						],
					},
				}),
			},
		}

		try {
			//#when
			await testCacheStore.updateConnectedProvidersCache(mockClient)

			//#then
			expect(testCacheStore.readConnectedProvidersCache()).toEqual(["openai"])
			expect(existsSync(sentinelPath)).toBe(true)
			expect(readFileSync(sentinelPath, "utf-8")).toBe(JSON.stringify({ keep: true }))
		} finally {
			if (existsSync(sentinelPath)) {
				rmSync(sentinelPath, { force: true })
			}
		}
	})

	test("findProviderModelMetadata returns rich cached metadata", async () => {
		//#given
		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["openai"],
						all: [
							{
								id: "openai",
								models: {
									"gpt-5.4": {
										id: "gpt-5.4",
										name: "GPT-5.4",
										temperature: false,
										variants: {
											low: {},
											high: {},
										},
										limit: { output: 128000 },
									},
								},
							},
						],
					},
				}),
			},
		}

		await testCacheStore.updateConnectedProvidersCache(mockClient)
		const cache = testCacheStore.readProviderModelsCache()

		//#when
		const result = findProviderModelMetadata("openai", "gpt-5.4", cache)

		//#then
		expect(result).toEqual({
			id: "gpt-5.4",
			name: "GPT-5.4",
			temperature: false,
			variants: {
				low: {},
				high: {},
			},
			limit: { output: 128000 },
		})
	})

	test("keeps normalized fallback ids when raw metadata id is not a string", async () => {
		const mockClient = {
			provider: {
				list: async () => ({
					data: {
						connected: ["openai"],
						all: [
							{
								id: "openai",
								models: {
									"o3-mini": {
										id: 123,
										name: "o3-mini",
									},
								},
							},
						],
					},
				}),
			},
		}

		await testCacheStore.updateConnectedProvidersCache(mockClient)
		const cache = testCacheStore.readProviderModelsCache()

		expect(cache?.models.openai).toEqual([
			{ id: "o3-mini", name: "o3-mini" },
		])
		expect(findProviderModelMetadata("openai", "o3-mini", cache)).toEqual({
			id: "o3-mini",
			name: "o3-mini",
		})
	})

	test("reads provider-models cache from readable directories when writable cache path differs", () => {
		const readableCacheDir = join(fakeUserCacheRoot, "preferred-oh-my-opencode")
		const writableCacheDir = join(fakeUserCacheRoot, "sandbox-oh-my-opencode")
		testCacheStore = createConnectedProvidersCacheStore(
			() => writableCacheDir,
			() => [readableCacheDir, writableCacheDir],
		)

		mkdirSync(readableCacheDir, { recursive: true })
		writeFileSync(
			join(readableCacheDir, "provider-models.json"),
			JSON.stringify({
				models: {
					openai: [{ id: "gpt-5.4", context: 200000 }],
				},
				connected: ["openai"],
				updatedAt: "2026-04-09T00:00:00.000Z",
			}),
		)

		expect(testCacheStore.hasProviderModelsCache()).toBe(true)
		expect(testCacheStore.readProviderModelsCache()).toEqual({
			models: {
				openai: [{ id: "gpt-5.4", context: 200000 }],
			},
			connected: ["openai"],
			updatedAt: "2026-04-09T00:00:00.000Z",
		})
	})
})
