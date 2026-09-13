# T02 / R18 — fork distribution isolation

Base: `c5aecc311f5295e872002309dcf72cfd96a8ad84`. Related issue: #12.
T01 evidence reviewed from PR #35: fixed source, tool versions, fixtures and
Linux/Windows observations are present. The upstream Windows CRLF failure
remains tracked in #36; the baseline is a measurement, not a product fix.

## Implementation

- Product `MD Workbench`, identifier `io.github.aharada54914.mdworkbench`,
  binary `md-workbench`, protocol `md-workbench`, private npm package and version 0.1.0.
- Tauri app-data (including AI snapshots/sessions) and WebView storage use the new
  application identity. No implicit copy of upstream settings or conversations.
  The internal Rust crate name is retained; it is not the installed binary name.
- Upstream updater endpoint/public key removed. Updater plugin is not registered
  and no capability grants updater commands. Frontend automatic/manual/install
  entry points return before importing updater APIs. The disabled state is visible
  in all three existing UI locales; it is not displayed as “up to date”.
- NSIS uses current-user installation. Upstream README, LICENSE and attribution
  are preserved. Version 0.1.0 starts an independent development line.
- `release.yml` only accepts explicit workflow dispatch and builds an unsigned
  Windows artifact, with read-only repository permission. No tag/version bump,
  release creation, signing secret or updater manifest. Public distribution and
  re-enabling signed updates remain T24/G4 work.

## Verification and limits

Local: Node 24.19.0 / pnpm 11.19.0; frozen lock install; Python distribution
boundary tests 3/3; updater tests 10/10. Existing updater behavior is retained
under an explicit test-only enabled-policy mock, while the new default-policy
negative test ensures no network/install/relaunch even with a stale candidate.
The first full unit run found one missing Chinese translation out of 1183 tests;
that omission was repaired and i18n tests passed 5/5. Production build passed.
GitHub CI uses Node 22.16.0 / pnpm 11.3.0, full Linux unit tests, both OS frontend
builds and distribution tests, plus Windows Rust tests and unsigned NSIS build.
The inherited AppImage smoke workflow also checks native Linux packaging.
CI results must be attached to the PR before accepting the change.

No Windows 11 user-device coexistence/uninstall/association trial, macOS native
trial, performance measurement, public release, signature or real update trial
has been performed. Windows Server CI is not a Windows 11 acceptance substitute.
Keep #12 open until its coexistence acceptance has evidence.

## Rollback

Revert code on a branch while retaining the disabled release workflow and updater
boundary. Reverting this entire PR on master would restore automatic upstream-style
publication and must not be done. Existing MerMark data is not migrated or deleted.
Do not use a normal upstream release to downgrade a fork installation.
