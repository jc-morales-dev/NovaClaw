# Device compatibility

NovaClaw is early software. A device belongs in the **verified** table only
after a person has installed the public APK and reported the checks below. A
successful build or emulator run is not counted as real-device verification.

## Verified devices

| Device | Android | CPU | Tester | APK/build | Bootstrap | Terminal | Agent turn | Phone tools | Evidence |
|---|---:|---|---|---|---|---|---|---|---|
| OPPO CPH2557 | 15 | arm64 | Author | v0.1.0 | Pass | Pass | Pass | Author-tested subset | [README demo](../README.md#novaclaw) |

Current evidence: **1 tester, 1 physical device, 0 third-party reports.** This
number should only change when a linked issue contains reproducible evidence.

## What a useful report includes

1. Device manufacturer and exact model.
2. Android version and CPU architecture.
3. NovaClaw release or commit tested.
4. Whether the Linux bootstrap completes.
5. Output of `uname -a` and `node --version` in the built-in terminal.
6. Whether one simple agent turn completes.
7. Phone connectors tested and the permission result.
8. Logs or screenshots with API keys, tokens, contacts, and location redacted.

Use the repository's **Device compatibility report** issue form. Maintainers
will review the evidence and then update this matrix. A failure report is just
as useful as a pass: it defines the actual compatibility boundary.

## Support policy

- Documented minimum: Android 8+, arm64.
- Verified today: only the device listed above.
- Not yet claimed: broad OEM compatibility, tablets, x86, Play Store install,
  unattended operation, or complete coverage of every phone connector.
