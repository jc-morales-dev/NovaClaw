# Third-Party Licenses

NovaClaw's **own source code** is MIT (see [LICENSE](LICENSE)). The **distributed
APK** aggregates third-party software, each under its own license. Aggregation
(shipping binaries side by side) does not relicense NovaClaw's code, but the
combined distribution must honor every component's terms.

| Component | Where | License | Notes |
|-----------|-------|---------|-------|
| **proot** | `jniLibs/*/libproot*.so` | GPLv2 | Prebuilt from Termux. Sources: https://github.com/termux/proot |
| **Termux bootstrap** (bash, coreutils, apt, dpkg, node…) | `assets/bootstrap-*.zip` | GPLv2 / GPLv3 / LGPL / BSD / MIT (per package) | Prebuilt from https://github.com/termux/termux-packages |
| **Node.js** (installed at runtime) | downloaded on device | MIT-like (Node license) | Not shipped in the APK; fetched by the user's device |
| **Shizuku** (`dev.rikka.shizuku`) | Gradle dependency | Apache-2.0 / MIT | https://github.com/RikkaApps/Shizuku |
| npm dependencies (React, Express, etc.) | bundled `agent.cjs` | MIT / ISC / BSD (see package-lock) | Standard permissive stack |

## GPL obligations (proot, and GPL parts of the bootstrap)

Because the APK ships GPLv2 binaries (proot; parts of the bootstrap), when you
**distribute the APK** you must:

1. Keep this notice and make it available to recipients.
2. Offer the corresponding source of the GPL components (a link to the upstream
   Termux repos at the pinned version satisfies this — proot and the bootstrap
   are unmodified prebuilts).
3. Not add restrictions that conflict with the GPL on those components.

NovaClaw does not modify proot or the bootstrap binaries; it invokes them as
separate processes. This keeps NovaClaw's own code under MIT while respecting the
GPL for the aggregated tools.

## Refreshing the prebuilts

`scripts/fetch_proot_so.py` re-downloads proot from the pinned Termux repo. The
bootstrap zips are produced by `scripts/build-minimal-bootstrap.mjs`. Both pull
from official Termux release artifacts.
