import { describe, expect, it, vi } from "vitest";
import { resolveBundleInput, isGithubBundleInput } from "./bundle-resolver";
import type { BundleManifest, IndexedSkill } from "./utils/types";

function bundle(overrides: Partial<BundleManifest> = {}): BundleManifest {
  return {
    version: 1,
    name: "saved-bundle",
    description: "Saved bundle",
    author: "tester",
    createdAt: "2026-06-22T00:00:00.000Z",
    skills: [
      {
        name: "saved-skill",
        installUrl: "github:owner/repo:skills/saved-skill",
      },
    ],
    ...overrides,
  };
}

function indexedSkill(overrides: Partial<IndexedSkill> = {}): IndexedSkill {
  return {
    name: "skill-a",
    description: "Skill A",
    version: "1.0.0",
    license: "MIT",
    creator: "tester",
    compatibility: "",
    allowedTools: [],
    installUrl: "github:owner/repo:skills/skill-a",
    relPath: "skills/skill-a",
    ...overrides,
  };
}

describe("isGithubBundleInput", () => {
  it("recognizes GitHub shorthand and HTTPS URLs", () => {
    expect(isGithubBundleInput("github:owner/repo")).toBe(true);
    expect(isGithubBundleInput("https://github.com/owner/repo")).toBe(true);
    expect(isGithubBundleInput("frontend-dev")).toBe(false);
    expect(isGithubBundleInput("./bundle.json")).toBe(false);
  });
});

describe("resolveBundleInput", () => {
  it("delegates non-GitHub inputs to loadBundle", async () => {
    const loadBundleFn = vi.fn(async () => bundle());

    const resolved = await resolveBundleInput("frontend-dev", {
      loadBundleFn,
    });

    expect(loadBundleFn).toHaveBeenCalledWith("frontend-dev");
    expect(resolved.sourceKind).toBe("saved");
    expect(resolved.bundle.name).toBe("saved-bundle");
    await expect(resolved.cleanup()).resolves.toBeUndefined();
  });

  it("uses a single explicit bundle from a GitHub repository", async () => {
    const cleanupTempFn = vi.fn(async () => undefined);
    const explicit = bundle({
      name: "owner-repo-marketing",
      skills: [
        {
          name: "skill-a",
          installUrl: "github:owner/repo:skills/skill-a",
        },
      ],
    });

    const resolved = await resolveBundleInput("github:owner/repo", {
      cloneToTempFn: vi.fn(async () => "/tmp/repo"),
      cleanupTempFn,
      discoverSkillsFn: vi.fn(async () => [indexedSkill({ name: "skill-a" })]),
      discoverExplicitRepoBundlesFn: vi.fn(async () => [explicit as any]),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(resolved.sourceKind).toBe("github");
    expect(resolved.bundle.name).toBe("owner-repo-marketing");
    expect(resolved.bundle.skills).toHaveLength(1);
    await resolved.cleanup();
    expect(cleanupTempFn).toHaveBeenCalledWith("/tmp/repo");
  });

  it("falls back to one all-skills bundle when no explicit bundle exists", async () => {
    const resolved = await resolveBundleInput("github:owner/repo", {
      cloneToTempFn: vi.fn(async () => "/tmp/repo"),
      cleanupTempFn: vi.fn(async () => undefined),
      discoverSkillsFn: vi.fn(async () => [
        indexedSkill({
          name: "skill-b",
          relPath: "skills/skill-b",
          installUrl: "github:owner/repo:skills/skill-b",
        }),
        indexedSkill({
          name: "skill-a",
          relPath: "skills/skill-a",
          installUrl: "github:owner/repo:skills/skill-a",
        }),
      ]),
      discoverExplicitRepoBundlesFn: vi.fn(async () => []),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(resolved.bundle).toMatchObject({
      version: 1,
      name: "owner-repo",
      author: "ASM (owner/repo)",
      createdAt: "2026-06-22T00:00:00.000Z",
      tags: ["repo-derived", "github"],
    });
    expect(resolved.bundle.skills.map((s) => s.name)).toEqual([
      "skill-a",
      "skill-b",
    ]);
    expect(resolved.bundle.skills.map((s) => s.installUrl)).toEqual([
      "github:owner/repo:skills/skill-a",
      "github:owner/repo:skills/skill-b",
    ]);
  });

  it("fails clearly when multiple explicit bundles exist", async () => {
    await expect(
      resolveBundleInput("github:owner/repo", {
        cloneToTempFn: vi.fn(async () => "/tmp/repo"),
        cleanupTempFn: vi.fn(async () => undefined),
        discoverSkillsFn: vi.fn(async () => [indexedSkill()]),
        discoverExplicitRepoBundlesFn: vi.fn(async () => [
          bundle({ name: "owner-repo-marketing" }) as any,
          bundle({ name: "owner-repo-social" }) as any,
        ]),
      }),
    ).rejects.toThrow(
      /Multiple bundles found.*owner-repo-marketing.*owner-repo-social/s,
    );
  });

  it("fails clearly when no explicit bundles or skills exist", async () => {
    await expect(
      resolveBundleInput("github:owner/repo", {
        cloneToTempFn: vi.fn(async () => "/tmp/repo"),
        cleanupTempFn: vi.fn(async () => undefined),
        discoverSkillsFn: vi.fn(async () => []),
        discoverExplicitRepoBundlesFn: vi.fn(async () => []),
      }),
    ).rejects.toThrow(
      'No bundle metadata or skills found in GitHub repository "owner/repo".',
    );
  });
});
