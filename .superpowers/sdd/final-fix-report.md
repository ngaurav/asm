# Final Fix Report

## 2026-06-22: GitHub URL bundle show and install abort cleanup

Fix details:
- Routed `asm bundle show <name|file|github-url>` through `resolveBundleInput` via `withResolvedBundleInput`, so GitHub URL bundles are resolved and the resolved bundle is printed before cleanup runs in `finally`.
- Changed `bundle install` interactive abort to return from the command instead of calling `process.exit(0)` inside the resolved-bundle cleanup region.
- Added focused coverage for resolver cleanup on early command return, local-file `bundle show` CLI behavior, and interactive bundle-install abort behavior without installing.

Verification:
- `npx vitest run src/cli.test.ts -t "withResolvedBundleInput|bundle show reads a valid bundle file|bundle install interactive abort exits without installing"`: passed, 3 tests.
- `npm run typecheck`: passed.
