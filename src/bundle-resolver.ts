import { basename } from "path";
import {
  cleanupTemp,
  cloneToTemp,
  discoverSkills,
  parseSource,
} from "./installer";
import { loadBundle } from "./bundler";
import { discoverExplicitRepoBundles } from "./repo-bundles";
import type {
  BundleManifest,
  IndexedSkill,
  RepoIndex,
  TransportMode,
} from "./utils/types";

export interface ResolveBundleInputOptions {
  transport?: TransportMode;
  loadBundleFn?: (nameOrPath: string) => Promise<BundleManifest>;
  cloneToTempFn?: typeof cloneToTemp;
  cleanupTempFn?: typeof cleanupTemp;
  discoverSkillsFn?: typeof discoverSkills;
  discoverExplicitRepoBundlesFn?: typeof discoverExplicitRepoBundles;
  now?: () => Date;
}

export interface ResolvedBundleInput {
  bundle: BundleManifest;
  sourceKind: "saved" | "file" | "github";
  cleanup: () => Promise<void>;
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isGithubBundleInput(input: string): boolean {
  return (
    input.startsWith("github:") ||
    /^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(input)
  );
}

function toIndexedSkill(
  skill: Awaited<ReturnType<typeof discoverSkills>>[number],
  owner: string,
  repo: string,
): IndexedSkill {
  return {
    name: skill.name,
    description: skill.description || "",
    version: skill.version || "",
    license: skill.license || "",
    creator: skill.creator || "",
    compatibility: skill.compatibility || "",
    allowedTools: skill.allowedTools || [],
    installUrl: `github:${owner}/${repo}:${skill.relPath}`,
    relPath: skill.relPath,
  };
}

function makeRepoIndex(
  owner: string,
  repo: string,
  skills: IndexedSkill[],
  now: () => Date,
): RepoIndex {
  return {
    repoUrl: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    updatedAt: now().toISOString(),
    skillCount: skills.length,
    skills,
  };
}

function allSkillsBundle(index: RepoIndex): BundleManifest {
  return {
    version: 1,
    name: `${slugify(index.owner)}-${slugify(index.repo)}`,
    description: `Skills from ${index.owner}/${index.repo}.`,
    author: `ASM (${index.owner}/${index.repo})`,
    createdAt: index.updatedAt,
    tags: ["repo-derived", "github"],
    skills: [...index.skills]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        name: skill.name,
        installUrl: skill.installUrl,
        description: skill.description || undefined,
        version: skill.version || undefined,
      })),
  };
}

function looksLikeFileInput(input: string): boolean {
  return input.includes("/") || input.includes("\\") || input.endsWith(".json");
}

export async function resolveBundleInput(
  input: string,
  options: ResolveBundleInputOptions = {},
): Promise<ResolvedBundleInput> {
  if (!isGithubBundleInput(input)) {
    const loadBundleFn = options.loadBundleFn ?? loadBundle;
    const bundle = await loadBundleFn(input);
    return {
      bundle,
      sourceKind: looksLikeFileInput(input) ? "file" : "saved",
      cleanup: async () => undefined,
    };
  }

  const source = parseSource(input);
  const cloneToTempFn = options.cloneToTempFn ?? cloneToTemp;
  const cleanupTempFn = options.cleanupTempFn ?? cleanupTemp;
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;
  const discoverExplicitRepoBundlesFn =
    options.discoverExplicitRepoBundlesFn ?? discoverExplicitRepoBundles;
  const now = options.now ?? (() => new Date());
  const repo = stripGitSuffix(source.repo || basename(input));
  const tempDir = await cloneToTempFn(source, options.transport ?? "auto");
  const cleanup = async () => cleanupTempFn(tempDir);

  try {
    const discoveredSkills = await discoverSkillsFn(tempDir);
    const indexedSkills = discoveredSkills.map((skill) =>
      toIndexedSkill(skill, source.owner, repo),
    );
    const index = makeRepoIndex(source.owner, repo, indexedSkills, now);
    const explicitBundles = await discoverExplicitRepoBundlesFn(tempDir, index);

    if (explicitBundles.length === 1) {
      return { bundle: explicitBundles[0], sourceKind: "github", cleanup };
    }

    if (explicitBundles.length > 1) {
      const names = explicitBundles.map((bundle) => bundle.name).join(", ");
      throw new Error(
        `Multiple bundles found in GitHub repository "${source.owner}/${repo}": ${names}. Selector UX is not supported yet.`,
      );
    }

    if (indexedSkills.length === 0) {
      throw new Error(
        `No bundle metadata or skills found in GitHub repository "${source.owner}/${repo}".`,
      );
    }

    return {
      bundle: allSkillsBundle(index),
      sourceKind: "github",
      cleanup,
    };
  } catch (err) {
    try {
      await cleanup();
    } catch {
      // Preserve the original failure. Cleanup is best-effort here.
    }
    throw err;
  }
}
