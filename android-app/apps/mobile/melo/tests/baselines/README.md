# Reviewed regression source fixtures

These 14 source-only fixtures preserve the pre-migration UI contracts exercised by the theme tests. They contain no Git database, author identities, logs, screenshots or device recordings. `manifest.json` records the original source reference and SHA-256 of each LF-normalized blob; `baseline-source.ts` checks it before use. MeloCanvas original portions are MIT; upstream portions retain the BBPlayer MIT notice in `android-app/LICENSE`.

The tests compare against these fixed implementations, not the current implementation, and therefore continue to detect behavioral regressions after a fresh repository is initialized. Do not regenerate them from HEAD to make a test pass.
