import { parseSource } from "./installer";
import {
  activateLibrarySkill,
  deactivateLibrarySkill,
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

export type LibraryBundleInstallSummary = LibraryBundleSummary;
export type LibraryBundleActivationSummary = LibraryBundleSummary;
export type LibraryBundleDeactivationSummary = LibraryBundleSummary;

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

function addResult(
  summary: LibraryBundleSummary,
  result: LibraryBundleSkillResult,
): void {
  summary.results.push(result);
  if (result.installed) summary.installed++;
  if (result.status === "activated") summary.activated++;
  if (result.status === "deactivated") summary.deactivated++;
  if (result.status === "skipped") summary.skipped++;
  if (result.status === "missing") summary.missing++;
  if (result.status === "failed") summary.failed++;
}

export function parseBundleInstallUrl(
  ref: BundleSkillRef,
): ParsedBundleInstallRef {
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

function sameEntrySource(
  entry: LibrarySkillEntry,
  parsed: ParsedBundleInstallRef,
): boolean {
  return (
    entry.source === parsed.source &&
    (entry.skillPath || "") === parsed.skillPath
  );
}

function singleOrAmbiguous(
  matches: Array<[string, LibrarySkillEntry]>,
): LibraryEntryMatch {
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
  const entries = Object.entries(lock.skills) as Array<
    [string, LibrarySkillEntry]
  >;
  let parsed: ParsedBundleInstallRef | null = null;
  try {
    parsed = parseBundleInstallUrl(ref);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const bySource = entries.filter(([, entry]) =>
      sameEntrySource(entry, parsed),
    );
    const sourceMatch = singleOrAmbiguous(bySource);
    if (sourceMatch) return sourceMatch;
  }

  const byDirName = entries.filter(([dirName]) => dirName === ref.name);
  const dirMatch = singleOrAmbiguous(byDirName);
  if (dirMatch) return dirMatch;

  const byFrontmatterName = entries.filter(
    ([, entry]) => entry.name === ref.name,
  );
  return singleOrAmbiguous(byFrontmatterName);
}

export async function installBundleToLibrary(
  bundle: BundleManifest,
  options: {
    force: boolean;
    installSkillFromRef: (
      ref: BundleSkillRef,
    ) => Promise<{ name: string; libraryPath: string }>;
  },
): Promise<LibraryBundleInstallSummary> {
  const summary = emptySummary(bundle.name, bundle.skills.length);
  for (const ref of bundle.skills) {
    try {
      const installed = await options.installSkillFromRef(ref);
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
    installSkillFromRef?: (
      ref: BundleSkillRef,
    ) => Promise<{ name: string; libraryPath: string }>;
  },
): Promise<LibraryBundleActivationSummary> {
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
    lockPath?: string;
    targetDir: string;
    provider: string;
    scope: "global" | "project";
    librarySkillsDir?: string;
  },
): Promise<LibraryBundleDeactivationSummary> {
  const summary = emptySummary(bundle.name, bundle.skills.length);
  const lock = options.lockPath
    ? await readLibraryLock(options.lockPath)
    : null;

  for (const ref of bundle.skills) {
    try {
      let activationName = ref.name;
      if (lock) {
        const match = findLibraryEntryForBundleSkill(ref, lock);
        if (match && "ambiguous" in match) {
          addResult(summary, {
            name: ref.name,
            status: "failed",
            reason: `Ambiguous library matches for "${ref.name}": ${match.ambiguous.join(", ")}`,
          });
          continue;
        }
        if (match) {
          activationName = match.dirName;
        }
      }

      const result = await deactivateLibrarySkill({
        activationName,
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
