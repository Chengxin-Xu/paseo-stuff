# Upstream provenance

## Plugin

- Repository: https://github.com/mcowger/paseo-plugins
- Commit: `91058be73840ae11b130b6bb7d34b07652462217`
- Subdirectory: `colorful-agent-activity`
- License: MIT, Copyright (c) 2026 Matt Cowger; original LICENSE retained.
- Imported from an installed local checkout, not a fresh upstream snapshot.
- Local changes already present at import: tools/reasoning default collapsed, manual-only expansion during streaming, React renderer regression tests (44 total tests), documentation and development-only test dependencies.

This fork publishes under the distinct manifest ID **readable-agent-activity**. Existing local installations may retain an explicit runtime alias; internal renderer kind strings remain unchanged. Do not enable this fork and another timeline-replacement plugin together.

## Changes in this fork

- Beta.6: one Input/Output formatter, twenty-line previews, a shared Show all, source-preserving JSON highlighting and tool icons.
- Manual-only expansion; minimal plain-text Thinking disclosure matches tool-row density. Messages remain native. The old Markdown reasoning parser is not restored.
- Thin source/text transport adaptation retains metadata, traces, attachments and native detail fields. Malformed and oversized text falls back without silent truncation.
- Earlier betas included summaries, reconstructed diffs, UI-label compaction and Raw/Copy controls. Those helpers and their obsolete tests are removed in beta.6, not retained behind hidden UI.
- No server entry; presentation uses public SDK modules and does not need daemon-side privileges.
- Additional pure/renderer tests and pinned host compatibility fixtures. Full display only; collapsed displays remain unsupported for cards.

Public screenshots are captured from synthetic data, not personal conversations. Their
left columns use a source-adapted Paseo native reference, not the upstream Activity
plugin. See [screenshot provenance](docs/screenshots.md) for exact source and limitations.

## Host test fixtures

Eight unmodified Paseo v0.15.3 source files and one reduced file from commit `d91ae138cb931447635e94296023414a58bedcc5`, under Apache-2.0, are used only in tests. Their license is not replaced by the plugin's MIT license.

See [fixture provenance](tests/fixtures/paseo-0.15.3/README.md) and [fixture LICENSE](tests/fixtures/paseo-0.15.3/LICENSE).
