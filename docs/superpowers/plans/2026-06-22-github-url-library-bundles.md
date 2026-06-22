# GitHub URL Library Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub URL bundle sources that can be installed into ASM's neutral library and activated or deactivated as a group.

**Architecture:** Add a focused resolver for bundle inputs, including GitHub URL repositories with explicit bundle metadata and all-skills fallback. Add focused library-bundle operations that install, activate, and deactivate bundle skill refs using existing library primitives. Keep `src/cli.ts` as orchestration glue and preserve existing direct provider bundle installs unless `--library` or the new activation subcommands are used.

**Tech Stack:** TypeScript, Node.js `fs/promises`, existing ASM installer/library/bundler modules, Vitest, `tsx`.

## Global Constraints

- Do not introduce dependency resolution.
- Do not add activation profiles, sandboxes, or project presets.
- Do not replace existing saved, predefined, or repo-derived bundle behavior.
- Do not remove or rename `asm activate` for single library skills.
- Do not make deactivation remove real provider directories.
- Do not implement interactive multi-bundle selection in the first slice.
- Without `--library`, `asm bundle install` keeps its current behavior: install bundle skills directly into the selected provider and scope.
- `asm bundle activate` requires `-s global` or `-s project`; `both` is invalid.
- Batch commands should continue after individual skill failures and return a non-zero exit code if any skill failed.

---

## File Structure

- Create `src/bundle-resolver.ts`: resolves saved/predefined/file bundle inputs through existing `loadBundle`, and resolves GitHub URL inputs by cloning, discovering explicit repo bundles, or falling back to all discovered skills.
- Create `src/bundle-resolver.test.ts`: unit tests for explicit GitHub bundle resolution, all-skills fallback, multiple explicit bundle failure, and existing `loadBundle` delegation.
- Create `src/library-bundles.ts`: batch library install, activate, and deactivate helpers. This module owns matching bundle skill refs to `library-lock.json` entries.
- Create `src/library-bundles.test.ts`: unit tests for matching precedence, install-missing behavior, activation, deactivation, and per-skill result summaries.
- Modify `src/cli.ts`: add `--install-missing` parsing, help text, `bundle activate`, `bundle deactivate`, and `bundle install --library` orchestration.
- Modify `src/cli.test.ts`: parser tests for `--install-missing`, `bundle activate`, and `bundle deactivate`.
- Modify `src/bundler.ts`: no changes planned.
- Modify `src/utils/types.ts`: no changes planned; keep operation result types local to `library-bundles.ts`.

---

### Task 1: Add Bundle Input Resolver

**Files:**
- Create: `src/bundle-resolver.ts`
- Create: `src/bundle-resolver.test.ts`
- Modify: none

**Interfaces:**
- Consumes:
  - `loadBundle(nameOrPath: string): Promise<BundleManifest>` from `src/bundler.ts`
  - `parseSource(source: string)` from `src/installer.ts`
  - `cloneToTemp(source, transport)` from `src/installer.ts`
  - `cleanupTemp(tempDir: string)` from `src/installer.ts`
  - `discoverSkills(rootDir: string)` from `src/installer.ts`
  - `discoverExplicitRepoBundles(repoRoot, repoIndex)` from `src/repo-bundles.ts`
- Produces:
  - `isGithubBundleInput(input: string): boolean`
  - `resolveBundleInput(input: string, options?: ResolveBundleInputOptions): Promise<ResolvedBundleInput>`

Add these exact types in `src/bundle-resolver.ts`:

```ts
import type { BundleManifest, RepoIndex, IndexedSkill } from "./utils/types";
import type { TransportMode } from "./utils/types";

export interface ResolveBundleInputOptions {
  transport?: TransportMode;
  loadBundleFn?: (nameOrPath: string) => Promise<BundleManifest>;
  cloneToTempFn?: typeof import("./installer").cloneToTemp;
  cleanupTempFn?: typeof import("./installer").cleanupTemp;
  discoverSkillsFn?: typeof import("./installer").discoverSkills;
  discoverExplicitRepoBundlesFn?: typeof import("./repo-bundles").discoverExplicitRepoBundles;
  now?: () => Date;
}

export interface ResolvedBundleInput {
  bundle: BundleManifest;
  sourceKind: "saved" | "file" | "github";
  cleanup: () => Promise<void>;
}
```

- [ ] **Step 1: Write failing resolver tests**

Add to `src/bundle-resolver.test.ts`:

```ts
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

    const resolved = await resolveBundleInput("frontend-dev", { loadBundleFn });

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
        indexedSkill({ name: "skill-b", relPath: "skills/skill-b", installUrl: "github:owner/repo:skills/skill-b" }),
        indexedSkill({ name: "skill-a", relPath: "skills/skill-a", installUrl: "github:owner/repo:skills/skill-a" }),
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
    expect(resolved.bundle.skills.map((s) => s.name)).toEqual(["skill-a", "skill-b"]);
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
    ).rejects.toThrow(/Multiple bundles found.*owner-repo-marketing.*owner-repo-social/s);
  });

  it("fails clearly when no explicit bundles or skills exist", async () => {
    await expect(
      resolveBundleInput("github:owner/repo", {
        cloneToTempFn: vi.fn(async () => "/tmp/repo"),
        cleanupTempFn: vi.fn(async () => undefined),
        discoverSkillsFn: vi.fn(async () => []),
        discoverExplicitRepoBundlesFn: vi.fn(async () => []),
      }),
    ).rejects.toThrow('No bundle metadata or skills found in GitHub repository "owner/repo".');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/bundle-resolver.test.ts
```

Expected: FAIL because `src/bundle-resolver.ts` does not exist.

- [ ] **Step 3: Implement resolver**

Create `src/bundle-resolver.ts`:

```ts
import { basename } from "path";
import { cleanupTemp, cloneToTemp, discoverSkills, parseSource } from "./installer";
import { loadBundle } from "./bundler";
import { discoverExplicitRepoBundles } from "./repo-bundles";
import type { BundleManifest, IndexedSkill, RepoIndex, TransportMode } from "./utils/types";

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
  return input.startsWith("github:") || /^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(input);
}

function toIndexedSkill(skill: Awaited<ReturnType<typeof discoverSkills>>[number], owner: string, repo: string): IndexedSkill {
  const relPath = skill.relPath;
  return {
    name: skill.name,
    description: skill.description || "",
    version: skill.version || "",
    license: skill.license || "",
    creator: skill.creator || "",
    compatibility: skill.compatibility || "",
    allowedTools: skill.allowedTools || [],
    installUrl: `github:${owner}/${repo}:${relPath}`,
    relPath,
  };
}

function makeRepoIndex(owner: string, repo: string, repoRoot: string, skills: IndexedSkill[], now: () => Date): RepoIndex {
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

export async function resolveBundleInput(
  input: string,
  options: ResolveBundleInputOptions = {},
): Promise<ResolvedBundleInput> {
  if (!isGithubBundleInput(input)) {
    const loadBundleFn = options.loadBundleFn ?? loadBundle;
    const bundle = await loadBundleFn(input);
    const sourceKind = input.includes("/") || input.includes("\\") || input.endsWith(".json") ? "file" : "saved";
    return { bundle, sourceKind, cleanup: async () => undefined };
  }

  const source = parseSource(input);
  if (!source.owner || !source.repo) {
    throw new Error(`Invalid GitHub bundle source: ${input}`);
  }

  const cloneToTempFn = options.cloneToTempFn ?? cloneToTemp;
  const cleanupTempFn = options.cleanupTempFn ?? cleanupTemp;
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;
  const discoverExplicitRepoBundlesFn =
    options.discoverExplicitRepoBundlesFn ?? discoverExplicitRepoBundles;
  const now = options.now ?? (() => new Date());
  const tempDir = await cloneToTempFn(source, options.transport ?? "auto");
  const cleanup = async () => cleanupTempFn(tempDir);

  try {
    const owner = source.owner;
    const repo = stripGitSuffix(source.repo || basename(tempDir));
    const discoveredSkills = await discoverSkillsFn(tempDir);
    const indexedSkills = discoveredSkills.map((skill) =>
      toIndexedSkill(skill, owner, repo),
    );
    const index = makeRepoIndex(owner, repo, tempDir, indexedSkills, now);
    const explicitBundles = await discoverExplicitRepoBundlesFn(tempDir, index);

    if (explicitBundles.length === 1) {
      return { bundle: explicitBundles[0], sourceKind: "github", cleanup };
    }

    if (explicitBundles.length > 1) {
      const names = explicitBundles.map((bundle) => bundle.name).join(", ");
      throw new Error(
        `Multiple bundles found in GitHub repository "${owner}/${repo}": ${names}. Selector UX is not supported yet.`,
      );
    }

    if (indexedSkills.length === 0) {
      throw new Error(
        `No bundle metadata or skills found in GitHub repository "${owner}/${repo}".`,
      );
    }

    return { bundle: allSkillsBundle(index), sourceKind: "github", cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
npx vitest run src/bundle-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit resolver**

```bash
git add src/bundle-resolver.ts src/bundle-resolver.test.ts
git commit -m "feat: resolve GitHub bundle inputs"
```

---

### Task 2: Add Library Bundle Batch Operations

**Files:**
- Create: `src/library-bundles.ts`
- Create: `src/library-bundles.test.ts`
- Modify: none

**Interfaces:**
- Consumes:
  - `BundleManifest`, `BundleSkillRef`, `LibraryLockFile`, `LibrarySkillEntry`
  - `readLibraryLock`, `listLibrarySkills`, `installLibrarySkill`, `activateLibrarySkill`, `deactivateLibrarySkill`
- Produces:
  - `parseBundleInstallUrl(ref: BundleSkillRef): ParsedBundleInstallRef`
  - `findLibraryEntryForBundleSkill(ref, lock): LibraryEntryMatch`
  - `installBundleToLibrary(bundle, options): Promise<LibraryBundleInstallSummary>`
  - `activateLibraryBundle(bundle, options): Promise<LibraryBundleActivationSummary>`
  - `deactivateLibraryBundle(bundle, options): Promise<LibraryBundleDeactivationSummary>`

Use these operation types:

```ts
export type LibraryBundleResultStatus =
  | "installed"
  | "activated"
  | "deactivated"
  | "skipped"
  | "missing"
  | "failed";

export interface LibraryBundleSkillResult {
  name: string;
  status: LibraryBundleResultStatus;
  reason?: string;
  installed?: boolean;
  libraryPath?: string;
  activationPath?: string;
}

export interface LibraryBundleSummary {
  bundleName: string;
  total: number;
  installed: number;
  activated: number;
  deactivated: number;
  skipped: number;
  missing: number;
  failed: number;
  results: LibraryBundleSkillResult[];
}
```

- [ ] **Step 1: Write failing tests for matching and activation**

Create `src/library-bundles.test.ts`:

```ts
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile, lstat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  activateLibraryBundle,
  deactivateLibraryBundle,
  findLibraryEntryForBundleSkill,
  parseBundleInstallUrl,
} from "./library-bundles";
import { writeLibraryLock } from "./library";
import type { BundleManifest, LibraryLockFile } from "./utils/types";

function bundle(): BundleManifest {
  return {
    version: 1,
    name: "owner-repo",
    description: "Bundle",
    author: "tester",
    createdAt: "2026-06-22T00:00:00.000Z",
    skills: [
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      { name: "skill-b", installUrl: "github:owner/repo:skills/skill-b" },
    ],
  };
}

describe("parseBundleInstallUrl", () => {
  it("splits GitHub repo source and skill path", () => {
    expect(parseBundleInstallUrl({ name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" })).toEqual({
      source: "github:owner/repo",
      sourceType: "github",
      skillPath: "skills/skill-a",
    });
  });
});

describe("findLibraryEntryForBundleSkill", () => {
  const lock: LibraryLockFile = {
    version: 1,
    skills: {
      aliased: {
        name: "different-frontmatter",
        version: "1.0.0",
        source: "github:owner/repo",
        sourceType: "github",
        commitHash: "abc",
        ref: "main",
        skillPath: "skills/skill-a",
        libraryPath: "/library/aliased",
        installedAt: "2026-06-22T00:00:00.000Z",
      },
      "skill-b": {
        name: "skill-b",
        version: "1.0.0",
        source: "github:someone/else",
        sourceType: "github",
        commitHash: "abc",
        ref: "main",
        skillPath: "skills/skill-b",
        libraryPath: "/library/skill-b",
        installedAt: "2026-06-22T00:00:00.000Z",
      },
    },
  };

  it("prefers source and skillPath over name", () => {
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      lock,
    );
    expect(match).toMatchObject({ dirName: "aliased", entry: lock.skills.aliased });
  });

  it("falls back to directory name", () => {
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-b", installUrl: "github:owner/repo:skills/missing" },
      lock,
    );
    expect(match).toMatchObject({ dirName: "skill-b", entry: lock.skills["skill-b"] });
  });

  it("returns ambiguous matches at the same precedence", () => {
    const ambiguous: LibraryLockFile = {
      version: 1,
      skills: {
        one: lock.skills.aliased,
        two: { ...lock.skills.aliased, libraryPath: "/library/two" },
      },
    };
    const match = findLibraryEntryForBundleSkill(
      { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
      ambiguous,
    );
    expect(match).toEqual({ ambiguous: ["one", "two"] });
  });
});

describe("library bundle activation", () => {
  let tempDir: string;
  let lockPath: string;
  let skillsDir: string;
  let targetDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "asm-library-bundle-"));
    lockPath = join(tempDir, "library-lock.json");
    skillsDir = join(tempDir, "library", "skills");
    targetDir = join(tempDir, "provider", "skills");
    for (const name of ["skill-a", "skill-b"]) {
      const dir = join(skillsDir, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`);
    }
    await writeLibraryLock(
      {
        version: 1,
        skills: {
          "skill-a": {
            name: "skill-a",
            version: "1.0.0",
            source: "github:owner/repo",
            sourceType: "github",
            commitHash: "abc",
            ref: "main",
            skillPath: "skills/skill-a",
            libraryPath: join(skillsDir, "skill-a"),
            installedAt: "2026-06-22T00:00:00.000Z",
          },
          "skill-b": {
            name: "skill-b",
            version: "1.0.0",
            source: "github:owner/repo",
            sourceType: "github",
            commitHash: "abc",
            ref: "main",
            skillPath: "skills/skill-b",
            libraryPath: join(skillsDir, "skill-b"),
            installedAt: "2026-06-22T00:00:00.000Z",
          },
        },
      },
      lockPath,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("activates all bundle skills from the library", async () => {
    const summary = await activateLibraryBundle(bundle(), {
      lockPath,
      targetDir,
      provider: "codex",
      scope: "project",
      force: false,
    });

    expect(summary).toMatchObject({
      bundleName: "owner-repo",
      total: 2,
      activated: 2,
      failed: 0,
    });
    await expect(readlink(join(targetDir, "skill-a"))).resolves.toBe(join(skillsDir, "skill-a"));
    await expect(readlink(join(targetDir, "skill-b"))).resolves.toBe(join(skillsDir, "skill-b"));
  });

  it("reports missing skills without installMissing", async () => {
    const partial = bundle();
    partial.skills.push({ name: "missing", installUrl: "github:owner/repo:skills/missing" });

    const summary = await activateLibraryBundle(partial, {
      lockPath,
      targetDir,
      provider: "codex",
      scope: "project",
      force: false,
    });

    expect(summary.missing).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results.find((r) => r.name === "missing")).toMatchObject({
      status: "missing",
      reason: 'Library skill "missing" is not installed. Use --install-missing.',
    });
  });

  it("deactivates all safe bundle symlinks and skips missing activations", async () => {
    await mkdir(targetDir, { recursive: true });
    await symlink(join(skillsDir, "skill-a"), join(targetDir, "skill-a"), "dir");

    const summary = await deactivateLibraryBundle(bundle(), {
      targetDir,
      provider: "codex",
      scope: "project",
      librarySkillsDir: skillsDir,
    });

    expect(summary).toMatchObject({
      total: 2,
      deactivated: 1,
      skipped: 1,
      failed: 0,
    });
    await expect(lstat(join(targetDir, "skill-a"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/library-bundles.test.ts
```

Expected: FAIL because `src/library-bundles.ts` does not exist.

- [ ] **Step 3: Implement matching and activation/deactivation helpers**

Create `src/library-bundles.ts`:

```ts
import { join } from "path";
import { parseSource } from "./installer";
import {
  activateLibrarySkill,
  deactivateLibrarySkill,
  installLibrarySkill,
  readLibraryLock,
} from "./library";
import type {
  BundleManifest,
  BundleSkillRef,
  LibraryLockFile,
  LibrarySkillEntry,
} from "./utils/types";

export type LibraryBundleResultStatus =
  | "installed"
  | "activated"
  | "deactivated"
  | "skipped"
  | "missing"
  | "failed";

export interface LibraryBundleSkillResult {
  name: string;
  status: LibraryBundleResultStatus;
  reason?: string;
  installed?: boolean;
  libraryPath?: string;
  activationPath?: string;
}

export interface LibraryBundleSummary {
  bundleName: string;
  total: number;
  installed: number;
  activated: number;
  deactivated: number;
  skipped: number;
  missing: number;
  failed: number;
  results: LibraryBundleSkillResult[];
}

export interface ParsedBundleInstallRef {
  source: string;
  sourceType: "registry" | "github" | "local";
  skillPath: string;
}

export type LibraryEntryMatch =
  | { dirName: string; entry: LibrarySkillEntry }
  | { ambiguous: string[] }
  | null;

function emptySummary(bundleName: string, total: number): LibraryBundleSummary {
  return {
    bundleName,
    total,
    installed: 0,
    activated: 0,
    deactivated: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
    results: [],
  };
}

function addResult(summary: LibraryBundleSummary, result: LibraryBundleSkillResult): void {
  summary.results.push(result);
  if (result.installed) summary.installed++;
  if (result.status === "activated") summary.activated++;
  if (result.status === "deactivated") summary.deactivated++;
  if (result.status === "skipped") summary.skipped++;
  if (result.status === "missing") summary.missing++;
  if (result.status === "failed") summary.failed++;
}

export function parseBundleInstallUrl(ref: BundleSkillRef): ParsedBundleInstallRef {
  const source = parseSource(ref.installUrl);
  if (source.isLocal) {
    return {
      source: `local:${source.localPath}`,
      sourceType: "local",
      skillPath: "",
    };
  }
  if (!source.owner || !source.repo) {
    throw new Error(`Unsupported bundle skill install URL: ${ref.installUrl}`);
  }
  return {
    source: `github:${source.owner}/${source.repo}`,
    sourceType: "github",
    skillPath: source.subpath || "",
  };
}

function sameEntrySource(entry: LibrarySkillEntry, parsed: ParsedBundleInstallRef): boolean {
  return entry.source === parsed.source && (entry.skillPath || "") === parsed.skillPath;
}

function singleOrAmbiguous(matches: Array<[string, LibrarySkillEntry]>): LibraryEntryMatch {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const [dirName, entry] = matches[0];
    return { dirName, entry };
  }
  return { ambiguous: matches.map(([dirName]) => dirName) };
}

export function findLibraryEntryForBundleSkill(
  ref: BundleSkillRef,
  lock: LibraryLockFile,
): LibraryEntryMatch {
  const entries = Object.entries(lock.skills) as Array<[string, LibrarySkillEntry]>;
  let parsed: ParsedBundleInstallRef | null = null;
  try {
    parsed = parseBundleInstallUrl(ref);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const bySource = entries.filter(([, entry]) => sameEntrySource(entry, parsed!));
    const sourceMatch = singleOrAmbiguous(bySource);
    if (sourceMatch) return sourceMatch;
  }

  const byDirName = entries.filter(([dirName]) => dirName === ref.name);
  const dirMatch = singleOrAmbiguous(byDirName);
  if (dirMatch) return dirMatch;

  const byFrontmatterName = entries.filter(([, entry]) => entry.name === ref.name);
  return singleOrAmbiguous(byFrontmatterName);
}

export async function installBundleToLibrary(
  bundle: BundleManifest,
  _options: {
    force: boolean;
    installSkillFromRef: (ref: BundleSkillRef) => Promise<{ name: string; libraryPath: string }>;
  },
): Promise<LibraryBundleSummary> {
  const summary = emptySummary(bundle.name, bundle.skills.length);
  for (const ref of bundle.skills) {
    try {
      const installed = await _options.installSkillFromRef(ref);
      addResult(summary, {
        name: ref.name,
        status: "installed",
        installed: true,
        libraryPath: installed.libraryPath,
      });
    } catch (err: any) {
      addResult(summary, {
        name: ref.name,
        status: "failed",
        reason: err?.message ?? String(err),
      });
    }
  }
  return summary;
}

export async function activateLibraryBundle(
  bundle: BundleManifest,
  options: {
    lockPath?: string;
    targetDir: string;
    provider: string;
    scope: "global" | "project";
    force: boolean;
    installMissing?: boolean;
    installSkillFromRef?: (ref: BundleSkillRef) => Promise<{ name: string; libraryPath: string }>;
  },
): Promise<LibraryBundleSummary> {
  const summary = emptySummary(bundle.name, bundle.skills.length);
  let lock = await readLibraryLock(options.lockPath);

  for (const ref of bundle.skills) {
    try {
      let match = findLibraryEntryForBundleSkill(ref, lock);
      let installed = false;

      if (!match && options.installMissing && options.installSkillFromRef) {
        await options.installSkillFromRef(ref);
        installed = true;
        lock = await readLibraryLock(options.lockPath);
        match = findLibraryEntryForBundleSkill(ref, lock);
      }

      if (!match) {
        addResult(summary, {
          name: ref.name,
          status: "missing",
          reason: `Library skill "${ref.name}" is not installed. Use --install-missing.`,
        });
        continue;
      }

      if ("ambiguous" in match) {
        addResult(summary, {
          name: ref.name,
          status: "failed",
          reason: `Ambiguous library matches for "${ref.name}": ${match.ambiguous.join(", ")}`,
        });
        continue;
      }

      const activation = await activateLibrarySkill({
        libraryPath: match.entry.libraryPath,
        targetDir: options.targetDir,
        activationName: match.dirName,
        force: options.force,
      });
      addResult(summary, {
        name: ref.name,
        status: "activated",
        installed,
        libraryPath: activation.targetPath,
        activationPath: activation.symlinkPath,
      });
    } catch (err: any) {
      addResult(summary, {
        name: ref.name,
        status: "failed",
        reason: err?.message ?? String(err),
      });
    }
  }

  return summary;
}

export async function deactivateLibraryBundle(
  bundle: BundleManifest,
  options: {
    targetDir: string;
    provider: string;
    scope: "global" | "project";
    librarySkillsDir?: string;
  },
): Promise<LibraryBundleSummary> {
  const summary = emptySummary(bundle.name, bundle.skills.length);
  for (const ref of bundle.skills) {
    try {
      const result = await deactivateLibrarySkill({
        activationName: ref.name,
        targetDir: options.targetDir,
        provider: options.provider,
        scope: options.scope,
        librarySkillsDir: options.librarySkillsDir,
      });
      addResult(summary, {
        name: ref.name,
        status: "deactivated",
        activationPath: result.path,
        libraryPath: result.target,
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes("is not active")) {
        addResult(summary, {
          name: ref.name,
          status: "skipped",
          reason: message,
        });
      } else {
        addResult(summary, {
          name: ref.name,
          status: "failed",
          reason: message,
        });
      }
    }
  }
  return summary;
}
```

Remove the unused `join` and `installLibrarySkill` imports if TypeScript flags them. They are intentionally not needed until CLI install glue exists.

- [ ] **Step 4: Run library bundle tests**

Run:

```bash
npx vitest run src/library-bundles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit batch helpers**

```bash
git add src/library-bundles.ts src/library-bundles.test.ts
git commit -m "feat: add library bundle operations"
```

---

### Task 3: Add CLI Flags, Help, and Command Routing

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes:
  - `resolveBundleInput(input, { transport })`
  - `installBundleToLibrary(bundle, options)`
  - `activateLibraryBundle(bundle, options)`
  - `deactivateLibraryBundle(bundle, options)`
  - `resolveProviderPath(config, provider, scope)` from `src/config.ts`
- Produces:
  - `ParsedArgs.flags.installMissing: boolean`
  - CLI routes for `asm bundle activate` and `asm bundle deactivate`
  - `asm bundle install <input> --library`

- [ ] **Step 1: Write failing parser tests**

Add these tests inside the `describe("parseArgs", ...)` block in `src/cli.test.ts`:

```ts
  test("parses bundle activate with install-missing", () => {
    const result = parse(
      "bundle",
      "activate",
      "github:owner/repo",
      "-p",
      "codex",
      "-s",
      "project",
      "--install-missing",
    );
    expect(result.command).toBe("bundle");
    expect(result.subcommand).toBe("activate");
    expect(result.positional).toEqual(["github:owner/repo"]);
    expect(result.flags.provider).toBe("codex");
    expect(result.flags.scope).toBe("project");
    expect(result.flags.installMissing).toBe(true);
  });

  test("parses bundle deactivate", () => {
    const result = parse(
      "bundle",
      "deactivate",
      "github:owner/repo",
      "-p",
      "codex",
      "-s",
      "project",
    );
    expect(result.command).toBe("bundle");
    expect(result.subcommand).toBe("deactivate");
    expect(result.positional).toEqual(["github:owner/repo"]);
    expect(result.flags.provider).toBe("codex");
    expect(result.flags.scope).toBe("project");
  });
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle activate|bundle deactivate"
```

Expected: FAIL because `installMissing` is not in `ParsedArgs`.

- [ ] **Step 3: Add parser flag and help text**

In `src/cli.ts`, add `installMissing: boolean;` to `ParsedArgs.flags`, initialize it to `false`, and parse:

```ts
    } else if (arg === "--install-missing") {
      result.flags.installMissing = true;
```

Update `printBundleHelp()`:

```ts
  activate <name|file|github-url>    Activate all library skills from a bundle
  deactivate <name|file|github-url>  Deactivate all library skills from a bundle
```

Add option line:

```ts
  --install-missing  Install missing bundle skills into the library before activation
```

Add examples:

```ts
  asm bundle install github:user/repo --library     ${ansi.dim("Install repo bundle into library")}
  asm bundle activate github:user/repo -p codex -s project
  asm bundle activate github:user/repo -p codex -s project --install-missing
  asm bundle deactivate github:user/repo -p codex -s project
```

- [ ] **Step 4: Run parser tests**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle activate|bundle deactivate"
```

Expected: PASS.

- [ ] **Step 5: Add command routing skeleton**

At the top of `src/cli.ts`, import:

```ts
import { resolveBundleInput } from "./bundle-resolver";
import {
  activateLibraryBundle,
  deactivateLibraryBundle,
  installBundleToLibrary,
  type LibraryBundleSummary,
} from "./library-bundles";
```

Add a local formatter near `cmdBundle`:

```ts
function printLibraryBundleSummary(summary: LibraryBundleSummary): void {
  console.error(
    `${ansi.bold("Summary:")} ${summary.total} total, ` +
      `${ansi.green(String(summary.installed))} installed, ` +
      `${ansi.green(String(summary.activated))} activated, ` +
      `${ansi.green(String(summary.deactivated))} deactivated, ` +
      `${ansi.dim(String(summary.skipped))} skipped, ` +
      `${ansi.yellow(String(summary.missing))} missing, ` +
      `${ansi.red(String(summary.failed))} failed`,
  );
}
```

Do not wire behavior yet. This step should compile after imports if Tasks 1 and 2 are complete.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit CLI parser and skeleton**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: add library bundle CLI flags"
```

---

### Task 4: Wire `bundle install --library`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes:
  - `resolveBundleInput`
  - `installBundleToLibrary`
  - existing install flow helpers in `src/cli.ts`, especially `installSelectedLibrarySkill`
- Produces:
  - `asm bundle install <input> --library` behavior

- [ ] **Step 1: Write failing CLI integration test for library install**

Add a new CLI integration test near the existing library CLI tests in `src/cli.test.ts`. Use `spawnCollect` with a temporary `HOME`, matching the existing library tests:

```ts
  test("bundle install --library installs all local bundle skills into the library", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "asm-bundle-library-cli-"));
    try {
      const sourceRoot = join(tempDir, "repo");
      const skillA = join(sourceRoot, "skills", "skill-a");
      const skillB = join(sourceRoot, "skills", "skill-b");
      await mkdir(skillA, { recursive: true });
      await mkdir(skillB, { recursive: true });
      await writeFile(join(skillA, "SKILL.md"), "---\nname: skill-a\nversion: 1.0.0\n---\n# A\n");
      await writeFile(join(skillB, "SKILL.md"), "---\nname: skill-b\nversion: 1.0.0\n---\n# B\n");
      const bundlePath = join(tempDir, "bundle.json");
      await writeFile(
        bundlePath,
        JSON.stringify({
          version: 1,
          name: "local-bundle",
          description: "Local test bundle",
          author: "test",
          createdAt: "2026-06-22T00:00:00.000Z",
          skills: [
            { name: "skill-a", installUrl: skillA },
            { name: "skill-b", installUrl: skillB },
          ],
        }),
      );

      const homeDir = join(tempDir, "home");
      const res = await spawnCollect(
        [
          "npx",
          "tsx",
          CLI_BIN,
          "bundle",
          "install",
          bundlePath,
          "--library",
          "-y",
          "--json",
        ],
        {
          env: { ...process.env, HOME: homeDir, NO_COLOR: "1" },
        },
      );
      expect(res.exitCode).toBe(0);
      const libraryDir = join(homeDir, ".config", "agent-skill-manager", "library");
      expect((await readdir(join(libraryDir, "skills"))).sort()).toEqual(["skill-a", "skill-b"]);
      const lock = JSON.parse(await readFile(join(libraryDir, "library-lock.json"), "utf-8"));
      expect(Object.keys(lock.skills).sort()).toEqual(["skill-a", "skill-b"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle install --library"
```

Expected: FAIL because `asm bundle install` still uses direct provider install behavior.

- [ ] **Step 3: Implement local helper for installing one bundle ref into library**

In `src/cli.ts`, near `installSelectedLibrarySkill`, add:

```ts
async function installBundleRefToLibrary(
  ref: BundleSkillRef,
  force: boolean,
): Promise<{ name: string; libraryPath: string }> {
  const source = parseSource(ref.installUrl);
  const isLocal = !!source.isLocal;
  let tempDir: string | null = null;
  try {
    const rootDir = isLocal ? source.localPath! : await cloneToTemp(source, "auto");
    tempDir = isLocal ? null : rootDir;
    const sourceDir = isLocal ? source.localPath! : source.subpath ? joinPath(rootDir, source.subpath) : rootDir;
    const metadata = await validateSkill(sourceDir);
    const libraryName = sanitizeName(ref.name || metadata.name || source.repo || metadata.name);
    const commitHash = tempDir ? await getCommitHash(tempDir) : "unknown";
    const installed = await installLibrarySkill({
      sourceDir,
      libraryName,
      source: isLocal ? `local:${source.localPath}` : `github:${source.owner}/${source.repo}`,
      sourceType: isLocal ? "local" : "github",
      commitHash: commitHash || "unknown",
      ref: source.ref || "main",
      skillPath: isLocal ? "" : source.subpath || "",
      force,
    });
    return { name: installed.name, libraryPath: installed.libraryPath };
  } finally {
    if (tempDir) await cleanupTemp(tempDir);
  }
}
```

- [ ] **Step 4: Branch `bundle install` on `--library`**

In `cmdBundle`, inside `case "install"`, after resolving and displaying the bundle but before provider resolution, add:

```ts
      if (args.flags.library) {
        const summary = await installBundleToLibrary(bundle, {
          force: args.flags.force,
          installSkillFromRef: (ref) =>
            installBundleRefToLibrary(ref, args.flags.force),
        });

        if (args.flags.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          printLibraryBundleSummary(summary);
        }

        if (summary.failed > 0) {
          process.exitCode = 1;
        }
        break;
      }
```

Keep all existing direct provider install code below this branch unchanged.

- [ ] **Step 5: Run targeted test and existing bundle tests**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle install --library"
npx vitest run src/bundler.test.ts src/library-bundles.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit library install CLI**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: install bundles into library"
```

---

### Task 5: Wire `bundle activate` and `bundle deactivate`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes:
  - `resolveBundleInput`
  - `activateLibraryBundle`
  - `deactivateLibraryBundle`
  - `installBundleRefToLibrary(ref, force)` from Task 4
  - `resolveProviderPath(config, provider, scope)`
- Produces:
  - `asm bundle activate <input> -p <tool> -s <global|project>`
  - `asm bundle activate <input> --install-missing`
  - `asm bundle deactivate <input> -p <tool> -s <global|project>`

- [ ] **Step 1: Write failing CLI integration tests**

Add tests to `src/cli.test.ts`:

```ts
  test("bundle activate links all library skills into a provider project scope", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "asm-bundle-activate-cli-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project");
      const configDir = join(homeDir, ".config", "agent-skill-manager");
      const librarySkills = join(configDir, "library", "skills");
      const targetDir = join(projectDir, ".codex", "skills");
      for (const name of ["skill-a", "skill-b"]) {
        const dir = join(librarySkills, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`);
      }
      await writeFile(
        join(configDir, "library", "library-lock.json"),
        JSON.stringify({
          version: 1,
          skills: {
            "skill-a": {
              name: "skill-a",
              version: "1.0.0",
              source: "github:owner/repo",
              sourceType: "github",
              commitHash: "abc",
              ref: "main",
              skillPath: "skills/skill-a",
              libraryPath: join(librarySkills, "skill-a"),
              installedAt: "2026-06-22T00:00:00.000Z",
            },
            "skill-b": {
              name: "skill-b",
              version: "1.0.0",
              source: "github:owner/repo",
              sourceType: "github",
              commitHash: "abc",
              ref: "main",
              skillPath: "skills/skill-b",
              libraryPath: join(librarySkills, "skill-b"),
              installedAt: "2026-06-22T00:00:00.000Z",
            },
          },
        }),
      );
      const bundlePath = join(tempDir, "bundle.json");
      await writeFile(
        bundlePath,
        JSON.stringify({
          version: 1,
          name: "local-bundle",
          description: "Local test bundle",
          author: "test",
          createdAt: "2026-06-22T00:00:00.000Z",
          skills: [
            { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
            { name: "skill-b", installUrl: "github:owner/repo:skills/skill-b" },
          ],
        }),
      );

      const res = await spawnCollect(
        [
          "npx",
          "tsx",
          CLI_BIN,
          "bundle",
          "activate",
          bundlePath,
          "-p",
          "codex",
          "-s",
          "project",
          "--json",
        ],
        {
          cwd: projectDir,
          env: { ...process.env, HOME: homeDir, NO_COLOR: "1" },
        },
      );
      expect(res.exitCode).toBe(0);
      expect(await readlink(join(targetDir, "skill-a"))).toBe(join(librarySkills, "skill-a"));
      expect(await readlink(join(targetDir, "skill-b"))).toBe(join(librarySkills, "skill-b"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("bundle deactivate removes active library symlinks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "asm-bundle-deactivate-cli-"));
    try {
      const homeDir = join(tempDir, "home");
      const projectDir = join(tempDir, "project");
      const configDir = join(homeDir, ".config", "agent-skill-manager");
      const librarySkills = join(configDir, "library", "skills");
      const targetDir = join(projectDir, ".codex", "skills");
      for (const name of ["skill-a", "skill-b"]) {
        const dir = join(librarySkills, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`);
      }
      await mkdir(targetDir, { recursive: true });
      await symlink(join(librarySkills, "skill-a"), join(targetDir, "skill-a"), "dir");
      await symlink(join(librarySkills, "skill-b"), join(targetDir, "skill-b"), "dir");
      const bundlePath = join(tempDir, "bundle.json");
      await writeFile(
        bundlePath,
        JSON.stringify({
          version: 1,
          name: "local-bundle",
          description: "Local test bundle",
          author: "test",
          createdAt: "2026-06-22T00:00:00.000Z",
          skills: [
            { name: "skill-a", installUrl: "github:owner/repo:skills/skill-a" },
            { name: "skill-b", installUrl: "github:owner/repo:skills/skill-b" },
          ],
        }),
      );

      const res = await spawnCollect(
        [
          "npx",
          "tsx",
          CLI_BIN,
          "bundle",
          "deactivate",
          bundlePath,
          "-p",
          "codex",
          "-s",
          "project",
          "--json",
        ],
        {
          cwd: projectDir,
          env: { ...process.env, HOME: homeDir, NO_COLOR: "1" },
        },
      );
      expect(res.exitCode).toBe(0);
      await expect(lstat(join(targetDir, "skill-a"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(targetDir, "skill-b"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle activate|bundle deactivate"
```

Expected: FAIL because routes are not implemented yet.

- [ ] **Step 3: Implement bundle activation command**

In `cmdBundle`, add a new `case "activate":`:

```ts
    case "activate": {
      const nameOrPath = args.positional[0];
      if (!nameOrPath) {
        error("Missing required argument: <name|file|github-url>");
        console.error(`Usage: asm bundle activate <name|file|github-url> -p <tool> -s <global|project>`);
        process.exit(2);
      }
      if (args.flags.scope !== "global" && args.flags.scope !== "project") {
        error("asm bundle activate requires --scope global or --scope project.");
        process.exit(2);
      }

      const resolved = await resolveBundleInput(nameOrPath, {
        transport: args.flags.transport,
      });
      try {
        const config = await loadConfig();
        const { provider } = await resolveProvider(config, args.flags.provider, false);
        const targetDir = resolveProviderPath(provider, args.flags.scope);
        const summary = await activateLibraryBundle(resolved.bundle, {
          targetDir,
          provider: provider.name,
          scope: args.flags.scope,
          force: args.flags.force,
          installMissing: args.flags.installMissing,
          installSkillFromRef: args.flags.installMissing
            ? (ref) => installBundleRefToLibrary(ref, args.flags.force)
            : undefined,
        });

        if (args.flags.json) console.log(JSON.stringify(summary, null, 2));
        else printLibraryBundleSummary(summary);

        if (summary.failed > 0 || summary.missing > 0) process.exitCode = 1;
      } finally {
        await resolved.cleanup();
      }
      break;
    }
```

- [ ] **Step 4: Implement bundle deactivation command**

In `cmdBundle`, add:

```ts
    case "deactivate": {
      const nameOrPath = args.positional[0];
      if (!nameOrPath) {
        error("Missing required argument: <name|file|github-url>");
        console.error(`Usage: asm bundle deactivate <name|file|github-url> -p <tool> -s <global|project>`);
        process.exit(2);
      }
      if (args.flags.scope !== "global" && args.flags.scope !== "project") {
        error("asm bundle deactivate requires --scope global or --scope project.");
        process.exit(2);
      }

      const resolved = await resolveBundleInput(nameOrPath, {
        transport: args.flags.transport,
      });
      try {
        const config = await loadConfig();
        const { provider } = await resolveProvider(config, args.flags.provider, false);
        const targetDir = resolveProviderPath(provider, args.flags.scope);
        const summary = await deactivateLibraryBundle(resolved.bundle, {
          targetDir,
          provider: provider.name,
          scope: args.flags.scope,
          librarySkillsDir: getLibrarySkillsDir(),
        });

        if (args.flags.json) console.log(JSON.stringify(summary, null, 2));
        else printLibraryBundleSummary(summary);

        if (summary.failed > 0) process.exitCode = 1;
      } finally {
        await resolved.cleanup();
      }
      break;
    }
```

- [ ] **Step 5: Run targeted CLI tests**

Run:

```bash
npx vitest run src/cli.test.ts -t "bundle activate|bundle deactivate"
```

Expected: PASS.

- [ ] **Step 6: Commit activation CLI**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: activate library bundles"
```

---

### Task 6: Full Verification and Documentation Touch-Up

**Files:**
- Modify: `README.md` only if the project already documents bundle commands in the CLI section.
- Modify: `docs/superpowers/specs/2026-06-22-github-url-library-bundles-design.md` only if implementation found a necessary correction.

**Interfaces:**
- Consumes all prior tasks.
- Produces verified final implementation.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npx vitest run src/bundle-resolver.test.ts src/library-bundles.test.ts src/bundler.test.ts src/repo-bundles.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run CLI tests**

Run:

```bash
npx vitest run src/cli.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full source test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Update README if needed**

Search:

```bash
rg -n "bundle install|bundle create|bundle list|--library" README.md docs
```

When the search finds a README bundle command section, add this concise example block there:

```md
Install a whole bundle into ASM's neutral library:

```bash
asm bundle install github:user/repo --library
```

Activate the bundle for one project:

```bash
asm bundle activate github:user/repo -p codex -s project --install-missing
```

Deactivate the bundle without deleting the library copies:

```bash
asm bundle deactivate github:user/repo -p codex -s project
```
```

When the search does not find a README bundle command section, leave README unchanged.

- [ ] **Step 6: Final status and commit**

Run:

```bash
git status --short
```

Expected: only intentional docs or final fixes.

Commit:

```bash
git add README.md docs/superpowers/specs/2026-06-22-github-url-library-bundles-design.md src
git commit -m "docs: document library bundle workflow"
```

If there were no doc/spec changes, skip the commit.

---

## Self-Review

- Spec coverage: The plan covers GitHub URL bundle resolution, explicit metadata, all-skills fallback, multiple explicit bundle failure, `bundle install --library`, `bundle activate`, `--install-missing`, `bundle deactivate`, JSON/human summaries through shared summary objects, and preservation of existing direct provider installs.
- Placeholder scan: No placeholder markers or unbounded “handle edge cases” steps remain. CLI integration tests use the existing `spawnCollect` plus temporary `HOME` pattern.
- Type consistency: Resolver returns `ResolvedBundleInput`; library batch operations consume `BundleManifest`; CLI consumes both. Matching uses the same repo-level `source` plus `skillPath` shape already written by `installLibrarySkill`.
