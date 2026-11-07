# Third-party provenance

Plugin-authored code is MIT. Dependencies retain their own licenses; npm integrity
hashes and exact resolved transitive versions are in package-lock.json.

| Dependency | Version / npm gitHead | License |
| --- | --- | --- |
| mathjax-full | 3.2.2 / ad8f5c21cb810236551da8c6512ba733e67357ee | Apache-2.0; third-party/MATHJAX-LICENSE |
| markdown-it | 14.3.3 / d372f0d8a68bef0b0acaa68868ce8ae8ba85b384 | MIT; third-party/MARKDOWN-IT-LICENSE |
| @resvg/resvg-wasm | 2.6.2 / 9ca058462ac529120c8cc84ddcd6fef644cc5406 | MPL-2.0; third-party/RESVG-LICENSE |

`prepare:markdown` transpiles the pinned markdown-it UMD distribution to ES5
syntax and wraps it as ESM for Hermes loading. Upstream comments/licenses are
preserved; only the stale source-map reference is removed. The generated parser
is ignored and rebuilt from the locked npm artifact, not maintained as a fork.

The resvg WASM is used unmodified. Its corresponding source is available at
https://github.com/yisibl/resvg-js/tree/9ca058462ac529120c8cc84ddcd6fef644cc5406
(including its Rust dependency lockfile and wasm build sources). The generated
base64 TypeScript is ignored and rebuilt from the npm artifact; it is not a
fork or a modification of MPL-covered sources. Retain this source-availability
notice and the license when distributing a compiled plugin.

MathJax's bundled TeX SVG glyph paths are used; no system font scan or external
font service. This prototype pins v3's synchronous, self-contained font path;
MathJax v4 migration remains a maintenance task before a general release.
Speech/XML accessibility modules are not imported into the runtime; the npm
dependency tree still overrides @xmldom/xmldom to fixed patch 0.9.12.

The parser was written for this prototype. PR #2562 informed delimiter/streaming
test cases, but its application renderer and tokenizer were not copied:
https://github.com/getpaseo/paseo/pull/2562

Nine unmodified Paseo source fixtures and one reduced file are Apache-2.0, pinned
to v0.15.3 commit d91ae138cb931447635e94296023414a58bedcc5. See
tests/fixtures/paseo-0.15.3/README.md and its LICENSE. They are test-only and excluded
from production bundles.
