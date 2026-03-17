import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadPluginConfig,
  mergeConfigs,
  parseConfigPartially,
} from "./plugin-config";
import type { OhMyOpenAgentConfig } from "./config";
import {
  CONFIG_BASENAME,
  LEGACY_CONFIG_BASENAME,
} from "./shared/plugin-identity";
import { getLogFilePath } from "./shared";

describe("mergeConfigs", () => {
  describe("categories merging", () => {
    // given base config has categories, override has different categories
    // when merging configs
    // then should deep merge categories, not override completely

    it("should deep merge categories from base and override", () => {
      const base = {
        categories: {
          general: {
            model: "openai/gpt-5.4",
            temperature: 0.5,
          },
          quick: {
            model: "anthropic/claude-haiku-4-5",
          },
        },
      } as OhMyOpenAgentConfig;

      const override = {
        categories: {
          general: {
            temperature: 0.3,
          },
          visual: {
            model: "google/gemini-3.1-pro",
          },
        },
      } as unknown as OhMyOpenAgentConfig;

      const result = mergeConfigs(base, override);

      // then general.model should be preserved from base
      expect(result.categories?.general?.model).toBe("openai/gpt-5.4");
      // then general.temperature should be overridden
      expect(result.categories?.general?.temperature).toBe(0.3);
      // then quick should be preserved from base
      expect(result.categories?.quick?.model).toBe("anthropic/claude-haiku-4-5");
      // then visual should be added from override
      expect(result.categories?.visual?.model).toBe("google/gemini-3.1-pro");
    });

    it("should preserve base categories when override has no categories", () => {
      const base: OhMyOpenAgentConfig = {
        categories: {
          general: {
            model: "openai/gpt-5.4",
          },
        },
      };

      const override: OhMyOpenAgentConfig = {};

      const result = mergeConfigs(base, override);

      expect(result.categories?.general?.model).toBe("openai/gpt-5.4");
    });

    it("should use override categories when base has no categories", () => {
      const base: OhMyOpenAgentConfig = {};

      const override: OhMyOpenAgentConfig = {
        categories: {
          general: {
            model: "openai/gpt-5.4",
          },
        },
      };

      const result = mergeConfigs(base, override);

      expect(result.categories?.general?.model).toBe("openai/gpt-5.4");
    });
  });

  describe("existing behavior preservation", () => {
    it("should deep merge agents", () => {
      const base: OhMyOpenAgentConfig = {
        agents: {
          oracle: { model: "openai/gpt-5.4" },
        },
      };

      const override: OhMyOpenAgentConfig = {
        agents: {
          oracle: { temperature: 0.5 },
          explore: { model: "anthropic/claude-haiku-4-5" },
        },
      };

      const result = mergeConfigs(base, override);

      expect(result.agents?.oracle?.model).toBe("openai/gpt-5.4");
      expect(result.agents?.oracle?.temperature).toBe(0.5);
      expect(result.agents?.explore?.model).toBe("anthropic/claude-haiku-4-5");
    });

    it("should merge disabled arrays without duplicates", () => {
      const base: OhMyOpenAgentConfig = {
        disabled_hooks: ["comment-checker", "think-mode"],
      };

      const override: OhMyOpenAgentConfig = {
        disabled_hooks: ["think-mode", "session-recovery"],
      };

      const result = mergeConfigs(base, override);

      expect(result.disabled_hooks).toContain("comment-checker");
      expect(result.disabled_hooks).toContain("think-mode");
      expect(result.disabled_hooks).toContain("session-recovery");
      expect(result.disabled_hooks?.length).toBe(3);
    });
  });
});

describe("parseConfigPartially", () => {
  describe("fully valid config", () => {
    //#given a config where all sections are valid
    //#when parsing the config
    //#then should return the full parsed config unchanged

    it("should return the full config when everything is valid", () => {
      const rawConfig = {
        agents: {
          oracle: { model: "openai/gpt-5.4" },
          momus: { model: "openai/gpt-5.4" },
        },
        disabled_hooks: ["comment-checker"],
      };

      const result = parseConfigPartially(rawConfig);

      expect(result).not.toBeNull();
      expect(result!.agents?.oracle?.model).toBe("openai/gpt-5.4");
      expect(result!.agents?.momus?.model).toBe("openai/gpt-5.4");
      expect(result!.disabled_hooks).toEqual(["comment-checker"]);
    });
  });

  describe("partially invalid config", () => {
    //#given a config where one section is invalid but others are valid
    //#when parsing the config
    //#then should return valid sections and skip invalid ones

    it("should preserve valid agent overrides when another section is invalid", () => {
      const rawConfig = {
        agents: {
          oracle: { model: "openai/gpt-5.4" },
          momus: { model: "openai/gpt-5.4" },
          prometheus: {
            permission: {
              edit: { "*": "ask", ".sisyphus/**": "allow" },
            },
          },
        },
        disabled_hooks: ["comment-checker"],
      };

      const result = parseConfigPartially(rawConfig);

      expect(result).not.toBeNull();
      expect(result!.disabled_hooks).toEqual(["comment-checker"]);
      expect(result!.agents).toBeUndefined();
    });

    it("should preserve valid agents when a non-agent section is invalid", () => {
      const rawConfig = {
        agents: {
          oracle: { model: "openai/gpt-5.4" },
        },
        disabled_hooks: ["not-a-real-hook"],
      };

      const result = parseConfigPartially(rawConfig);

      expect(result).not.toBeNull();
      expect(result!.agents?.oracle?.model).toBe("openai/gpt-5.4");
      expect(result!.disabled_hooks).toEqual(["not-a-real-hook"]);
    });
  });

  describe("completely invalid config", () => {
    //#given a config where all sections are invalid
    //#when parsing the config
    //#then should return an empty object (not null)

    it("should return empty object when all sections are invalid", () => {
      const rawConfig = {
        agents: { oracle: { temperature: "not-a-number" } },
        disabled_hooks: ["not-a-real-hook"],
      };

      const result = parseConfigPartially(rawConfig);

      expect(result).not.toBeNull();
      expect(result!.agents).toBeUndefined();
      expect(result!.disabled_hooks).toEqual(["not-a-real-hook"]);
    });
  });

  describe("empty config", () => {
    //#given an empty config object
    //#when parsing the config
    //#then should return an empty object (fast path - full parse succeeds)

    it("should return empty object for empty input", () => {
      const result = parseConfigPartially({});

      expect(result).not.toBeNull();
      expect(Object.keys(result!).length).toBe(0);
    });
  });

  describe("unknown keys", () => {
    //#given a config with keys not in the schema
    //#when parsing the config
    //#then should silently ignore unknown keys and preserve valid ones

    it("should ignore unknown keys and return valid sections", () => {
      const rawConfig = {
        agents: {
          oracle: { model: "openai/gpt-5.4" },
        },
        some_future_key: { foo: "bar" },
      };

      const result = parseConfigPartially(rawConfig);

      expect(result).not.toBeNull();
      expect(result!.agents?.oracle?.model).toBe("openai/gpt-5.4");
      expect((result as Record<string, unknown>)["some_future_key"]).toBeUndefined();
    });
  });
});

describe("loadPluginConfig", () => {
  let tempDirectory: string;
  let opencodeConfigDirectory: string;
  let projectOpencodeDirectory: string;
  let originalOpencodeConfigDirectory: string | undefined;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omo-config-test-"));
    opencodeConfigDirectory = path.join(tempDirectory, "user-config");
    projectOpencodeDirectory = path.join(tempDirectory, ".opencode");
    fs.mkdirSync(opencodeConfigDirectory, { recursive: true });
    fs.mkdirSync(projectOpencodeDirectory, { recursive: true });

    originalOpencodeConfigDirectory = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDirectory;

    fs.writeFileSync(getLogFilePath(), "", "utf-8");
  });

  afterEach(() => {
    if (originalOpencodeConfigDirectory === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDirectory;
    }

    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  describe("#given new config file exists", () => {
    describe("#when loading config", () => {
      it("#then finds oh-my-openagent.jsonc", () => {
        const newConfigPath = path.join(
          opencodeConfigDirectory,
          `${CONFIG_BASENAME}.jsonc`
        );
        fs.writeFileSync(newConfigPath, '{"disabled_hooks":["comment-checker"]}\n', "utf-8");

        const config = loadPluginConfig(tempDirectory, {});

        expect(config.disabled_hooks).toEqual(["comment-checker"]);
      });
    });
  });

  describe("#given only legacy config file exists", () => {
    describe("#when loading config", () => {
      it("#then falls back to oh-my-opencode.jsonc", () => {
        const legacyConfigPath = path.join(
          opencodeConfigDirectory,
          `${LEGACY_CONFIG_BASENAME}.jsonc`
        );
        fs.writeFileSync(legacyConfigPath, '{"disabled_hooks":["think-mode"]}\n', "utf-8");

        const config = loadPluginConfig(tempDirectory, {});

        expect(config.disabled_hooks).toEqual(["think-mode"]);
      });

      it("#then auto-renames oh-my-opencode.jsonc to oh-my-openagent.jsonc with backup", () => {
        const legacyConfigPath = path.join(
          opencodeConfigDirectory,
          `${LEGACY_CONFIG_BASENAME}.jsonc`
        );
        const legacyContent = '{"disabled_hooks":["session-recovery"]}\n';
        fs.writeFileSync(legacyConfigPath, legacyContent, "utf-8");

        const config = loadPluginConfig(tempDirectory, {});

        const newConfigPath = path.join(
          opencodeConfigDirectory,
          `${CONFIG_BASENAME}.jsonc`
        );
        expect(config.disabled_hooks).toEqual(["session-recovery"]);
        expect(fs.existsSync(newConfigPath)).toBe(true);
        expect(fs.existsSync(legacyConfigPath)).toBe(false);
        expect(fs.readFileSync(newConfigPath, "utf-8")).toBe(legacyContent);

        const backupFiles = fs
          .readdirSync(opencodeConfigDirectory)
          .filter((fileName) => fileName.startsWith(`${LEGACY_CONFIG_BASENAME}.jsonc.bak.`));
        expect(backupFiles.length).toBe(1);
        expect(
          fs.readFileSync(path.join(opencodeConfigDirectory, backupFiles[0]!), "utf-8")
        ).toBe(legacyContent);
      });
    });
  });

  describe("#given both new and legacy config files exist", () => {
    describe("#when loading config", () => {
      it("#then new name wins and logs warning about old file", () => {
        const newConfigPath = path.join(
          opencodeConfigDirectory,
          `${CONFIG_BASENAME}.jsonc`
        );
        const legacyConfigPath = path.join(
          opencodeConfigDirectory,
          `${LEGACY_CONFIG_BASENAME}.jsonc`
        );
        fs.writeFileSync(newConfigPath, '{"disabled_hooks":["comment-checker"]}\n', "utf-8");
        fs.writeFileSync(legacyConfigPath, '{"disabled_hooks":["think-mode"]}\n', "utf-8");

        const config = loadPluginConfig(tempDirectory, {});

        expect(config.disabled_hooks).toEqual(["comment-checker"]);
        const logs = fs.readFileSync(getLogFilePath(), "utf-8");
        expect(logs).toContain("legacy config also exists");
      });
    });
  });

  describe("#given legacy rename fails", () => {
    describe("#when loading config", () => {
      it("#then logs warning and continues loading legacy config", () => {
        const legacyConfigPath = path.join(
          opencodeConfigDirectory,
          `${LEGACY_CONFIG_BASENAME}.jsonc`
        );
        fs.writeFileSync(legacyConfigPath, '{"disabled_hooks":["hashline-read-enhancer"]}\n', "utf-8");
        fs.chmodSync(legacyConfigPath, 0o444);

        const renameError = new Error("EACCES: permission denied");
        const renameSpy = spyOn(fs, "renameSync").mockImplementation(() => {
          throw renameError;
        });

        try {
          const config = loadPluginConfig(tempDirectory, {});

          expect(config.disabled_hooks).toEqual(["hashline-read-enhancer"]);
          const logs = fs.readFileSync(getLogFilePath(), "utf-8");
          expect(logs).toContain("Failed to migrate legacy config path");
        } finally {
          renameSpy.mockRestore();
          fs.chmodSync(legacyConfigPath, 0o644);
        }
      });
    });
  });
});
