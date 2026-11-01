# CI tool dependencies

These private packages are test tooling, not plugin runtime dependencies. Keep
plugins independently installable. Install each directory with `npm ci
--ignore-scripts --no-audit --no-fund --prefer-offline`.

- `paseo/`: official prebuilt npm CLI and daemon, pinned to the verified host.
- `dsh/`: full official DSH npm distribution, including its real Windows
  `dsh.cmd` shim. Do not replace it with a mock or a reduced ACP-only package.

Lockfiles avoid resolving hundreds of transitive version ranges on every run.
Do not use `--legacy-peer-deps` here: DSH imports peer dependencies at runtime.
Native optional packages are downloaded prebuilt; CI does not compile tools.

When updating the host or the tested DSH release, update the corresponding
package.json and regenerate its lockfile with
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` from
that directory. For DSH, compare npm `latest` and `next`, select the newer
official version, and run the Windows daemon check before recording support.

## Caches and checks

Use setup-node's npm download cache, not node_modules or daemon homes. Its keys
include both plugin and tool locks where applicable, so a tool update invalidates
the correct cache. Node 22 and 24 share downloads, not native installed modules.
Only Windows installs DSH. Package smoke jobs install Paseo, but ordinary plugin
checks do not. Windows uses one explicit npm cache path for setup-node and all
installs: changing npm's prefix can otherwise change globalconfig and silently
send tool downloads to a different, uncached directory.

All plugin tests still run on Node 22 and 24. Windows additionally runs all DSH
tests and the real daemon/provider/model-catalog smoke check in independent jobs;
typecheck and lint are already covered on Ubuntu with Node 24. Tool installations
run concurrently, with both exit statuses checked. The smoke job installs only
the plugin's production dependencies, like the npm package checks. There are no
cross-job dependencies.

CI ignores root Markdown, `docs/**`, CI tooling documentation, and Markdown directly inside plugin roots.
Nested Markdown test fixtures remain CI inputs. The repository had no required
checks or rulesets when this filter was introduced. Before requiring checks,
replace workflow-level filtering with an always-running change detector and a
stable aggregate gate that passes documentation-only changes but fails any
required failed/cancelled job. Do not require a path-filtered workflow as-is.

Only PR runs cancel superseded runs. Non-PR concurrency keys use run IDs:
using a shared main key with cancel-in-progress false can still discard an older
pending main run. Release checks and publishing are never cancelled by PRs.
