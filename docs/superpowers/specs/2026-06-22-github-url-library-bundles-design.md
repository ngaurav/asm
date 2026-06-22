# GitHub URL Library Bundles Design

## Purpose

ASM already has three related concepts:

- regular skill installs into provider directories
- neutral library installs plus single-skill activation
- bundle manifests that install a curated group of skills

The missing workflow is activating a whole group of library skills for a project or provider scope. This is especially important for GitHub repositories that are already organized as bundles, such as a repository containing multiple social-card skills or a marketing skill collection.

This design extends the existing bundle command surface so GitHub URLs can act as bundle sources, and bundles can be installed into or activated from the neutral ASM library.

## Goals

- Let users install all skills from a GitHub URL bundle into the neutral library in one command.
- Let users activate all library skills in a bundle into a provider scope in one command.
- Let users deactivate all active symlinks for a bundle in one command.
- Reuse the existing `asm bundle` mental model instead of introducing an `asm install --bundle` flag.
- Preserve existing direct provider bundle install behavior.
- Use existing repo explicit-bundle discovery when available, with a sensible all-skills fallback for GitHub skill repositories.
- Preserve source metadata per skill so `asm library update` continues to work.

## Non-Goals

- Do not introduce dependency resolution.
- Do not add activation profiles, sandboxes, or project presets.
- Do not replace existing saved, predefined, or repo-derived bundle behavior.
- Do not remove or rename `asm activate` for single library skills.
- Do not make deactivation remove real provider directories.
- Do not implement interactive multi-bundle selection in the first slice.

## Command Surface

### Library Bundle Install

```sh
asm bundle install <name|file|github-url> --library [-y] [--json] [--force]
```

Without `--library`, `asm bundle install` keeps its current behavior: install bundle skills directly into the selected provider and scope.

With `--library`, the command installs each skill in the bundle into ASM's neutral library.

Examples:

```sh
asm bundle install https://github.com/kostja94/social-cards-skills --library -y
asm bundle install github:kostja94/marketing-skills --library --json
asm bundle install frontend-dev --library
```

### Bundle Activate

```sh
asm bundle activate <name|file|github-url> -p <tool> -s <global|project> [--install-missing] [--json] [--force]
```

Activates all bundle skills from the neutral library into the selected provider scope by creating symlinks.

If a bundle skill is not installed in the library:

- without `--install-missing`, report it as missing and leave it unactivated
- with `--install-missing`, install the missing skill into the library first, then activate it

Examples:

```sh
asm bundle activate https://github.com/kostja94/social-cards-skills -p codex -s project
asm bundle activate github:kostja94/marketing-skills -p claude -s global --install-missing
```

### Bundle Deactivate

```sh
asm bundle deactivate <name|file|github-url> -p <tool> -s <global|project> [--json]
```

Removes active provider symlinks for all bundle skills. It reuses the existing library deactivation safety model: remove symlinks only, and only when the resolved target is inside ASM's library skills directory.

Example:

```sh
asm bundle deactivate https://github.com/kostja94/social-cards-skills -p codex -s project
```

### Bundle Show

`asm bundle show <github-url>` should display the resolved GitHub URL bundle the same way it displays saved or predefined bundles today.

This makes bundle resolution inspectable before install or activation:

```sh
asm bundle show https://github.com/kostja94/marketing-skills
```

## GitHub URL Bundle Resolution

A GitHub URL bundle source resolves in this order:

1. Explicit bundle metadata in the repository.
2. A default all-skills bundle inferred from discovered skill directories in the repository.

Explicit bundle metadata uses the existing repo-bundle discovery paths:

```text
asm-bundles.json
asm.bundle.json
.asm/bundles.json
.asm/bundle.json
bundles/*.json
data/bundles/*.json
.asm/bundles/*.json
```

If exactly one explicit bundle is found, use it.

If multiple explicit bundles are found, fail with an actionable message that lists the bundle names. The first slice should not add interactive selection or a new selector syntax.

If no explicit bundle is found, discover skills in the repository and create one default bundle containing every discovered skill. This default bundle should be named from the repository, for example `kostja94-social-cards-skills`.

If no skills are discovered, fail with a clear error that no bundle or skills were found.

## Data Model

The existing `BundleManifest` remains the primary group recipe:

```json
{
  "version": 1,
  "name": "kostja94-social-cards-skills",
  "description": "Skills from kostja94/social-cards-skills.",
  "author": "ASM (kostja94/social-cards-skills)",
  "createdAt": "2026-06-22T00:00:00.000Z",
  "tags": ["repo-derived", "github"],
  "skills": [
    {
      "name": "social-card-generator",
      "installUrl": "github:kostja94/social-cards-skills:skills/social-card-generator"
    }
  ]
}
```

No new persisted bundle format is required.

Library installs continue to write one `library-lock.json` entry per skill. Each entry records:

- source URL
- source type
- commit hash
- ref
- repo-relative `skillPath`
- library path
- installed timestamp

This preserves compatibility with `asm library update`.

## Data Flow

### Resolve Bundle Source

1. Accept a saved bundle name, predefined bundle name, local JSON file, or GitHub URL.
2. For non-GitHub bundle inputs, keep the existing `loadBundle` path.
3. For GitHub URL inputs, clone or otherwise fetch the repository using the existing install source helpers.
4. Discover explicit repo bundle metadata.
5. If no explicit bundle exists, discover skill directories and build the default all-skills bundle.
6. Convert every skill to a `BundleSkillRef` with a concrete install URL that includes the skill subpath.

### Library Bundle Install

1. Resolve the bundle.
2. For each skill ref, resolve the install URL with the existing install source parser.
3. Validate the skill source.
4. Build an `InstallLibrarySkillPlan`.
5. Call `installLibrarySkill`.
6. Continue through per-skill failures and summarize all results.

### Bundle Activate

1. Resolve the bundle.
2. Load `library-lock.json`.
3. For each bundle skill, find the corresponding library entry.
4. Prefer matching by normalized source plus `skillPath`.
5. Fall back to exact library directory name or frontmatter skill name.
6. If missing and `--install-missing` is set, install the skill into the library.
7. Resolve provider and scope using existing config helpers.
8. Call `activateLibrarySkill` for each resolved library skill.
9. Continue through per-skill failures and summarize all results.

### Bundle Deactivate

1. Resolve the bundle.
2. Resolve provider and scope.
3. For each bundle skill, determine the activation name.
4. Call `deactivateLibrarySkill`.
5. Treat missing activations as skipped rather than fatal for the whole bundle.
6. Continue through per-skill failures and summarize all results.

## Matching Rules

Bundle activation needs stable matching because a skill can be aliased or have a frontmatter name that differs from its directory name.

Use this precedence:

1. Library lock entry whose `source` and `skillPath` match the bundle skill's resolved install URL.
2. Library lock entry whose directory name matches the bundle skill `name`.
3. Library lock entry whose frontmatter `name` matches the bundle skill `name`.

If multiple entries match at the same precedence, fail that skill with an ambiguity message rather than guessing.

## Output

Human output should show per-skill status and a summary.

Example:

```text
Bundle: kostja94-social-cards-skills (2 skills)

  social-card-generator  installed, activated
  social-card-reviewer   already in library, activated

Summary: 2 total, 2 activated, 0 failed
```

JSON output should include the bundle name, counts, and per-skill results:

```json
{
  "bundleName": "kostja94-social-cards-skills",
  "total": 2,
  "installed": 1,
  "activated": 2,
  "skipped": 0,
  "missing": 0,
  "failed": 0,
  "results": [
    {
      "name": "social-card-generator",
      "status": "activated",
      "installed": true,
      "libraryPath": "/Users/example/.config/agent-skill-manager/library/skills/social-card-generator",
      "activationPath": "/repo/.codex/skills/social-card-generator"
    }
  ]
}
```

## Error Handling

- Unknown bundle input should keep the existing saved/predefined bundle error style.
- GitHub URL with multiple explicit bundles should fail and list the discovered bundle names. Selector UX is an open follow-up.
- GitHub URL with no bundle metadata and no discovered skills should fail clearly.
- `asm bundle activate` requires `-s global` or `-s project`; `both` is invalid.
- Missing library skills should be reported per skill. Without `--install-missing`, the command exits non-zero if any requested activation is missing.
- Activation conflicts should reuse existing `activateLibrarySkill` errors and honor `--force`.
- Deactivation should only remove safe library symlinks and should never remove real directories.
- Batch commands should continue after individual skill failures and return a non-zero exit code if any skill failed.

## Testing

Add focused tests for:

- `parseArgs` recognizes `bundle activate` and `bundle deactivate`.
- `asm bundle install <github-url> --library` installs every resolved skill into the library.
- Existing `asm bundle install <bundle> -p <tool> -s <scope>` behavior remains unchanged without `--library`.
- GitHub URL bundle resolution uses a single explicit repo bundle when present.
- GitHub URL bundle resolution falls back to an all-skills repo bundle when explicit metadata is absent.
- GitHub URL bundle resolution fails clearly when multiple explicit bundles are present.
- `asm bundle activate <github-url> -p codex -s project` creates symlinks for installed library skills.
- `asm bundle activate <github-url> --install-missing` installs missing library skills before activation.
- `asm bundle activate <github-url>` reports missing library skills without `--install-missing`.
- `asm bundle deactivate <github-url>` removes only safe activation symlinks.
- JSON output reports per-skill statuses and summary counts.

## Open Follow-Ups

- Add selector UX for repositories with multiple explicit bundles.
- Add optional activation aliases at bundle level.
- Add bundle-level update commands on top of `asm library update`.
- Add project activation manifests if future UX needs to know which bundle created a symlink.
