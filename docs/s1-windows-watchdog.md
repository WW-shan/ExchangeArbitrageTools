# S1 Windows Rotation Watchdog

Status: implemented 2026-10-29. This document is the operational contract for
the Windows process supervisor used by the live S1 rotation.

## Process model

```text
Windows Task Scheduler (optional, at logon)
  -> powershell.exe scripts/watch-rotation.ps1
       -> node --import tsx apps/executor/src/main.ts --auto
       -> node --import tsx apps/scanner/src/main.ts
```

The watchdog is the only lifecycle manager. It starts the executor first and
waits for a fresh executor heartbeat before starting the scanner. No `tsx`
wrapper process is used, so the PID in the heartbeat is the real Node process.

## Files

| Path                                         | Purpose                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| `data/rotation-watchdog.lock`                | `FileShare.None` single-instance lock                 |
| `data/rotation-watchdog.pid`                 | Current watchdog PID                                  |
| `data/rotation-watchdog.status.json`         | Machine-readable lifecycle status                     |
| `data/rotation-executor.heartbeat.json`      | Executor PID/runId/phase/freshness                    |
| `data/rotation-scanner.heartbeat.json`       | Scanner PID/runId/phase/freshness                     |
| `data/rotation.stop`                         | Graceful stop request; removed only by explicit start |
| `data/logs/rotation-watchdog-YYYYMMDD.jsonl` | Watchdog event log                                    |
| `data/logs/executor-*.out.log` / `.err.log`  | Per-start executor logs                               |
| `data/logs/scanner-*.out.log` / `.err.log`   | Per-start scanner logs                                |

Every heartbeat write uses a temporary file plus rename. Heartbeats include
`version`, `role`, `runId`, `pid`, `startedAt`, `updatedAt`, `state`, `phase`
and progress details.

## Commands

```powershell
# Start in the background after removing an old stop file
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-rotation.ps1

# Foreground is useful for debugging and keeps the same watchdog behavior
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-rotation.ps1 -Foreground

# Read-only status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rotation-status.ps1

# Graceful stop. The stop file remains until the next explicit start.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-rotation.ps1

# Immediate safety halt without needing API keys
npm run rotation:halt

# Release only after reviewing open orders, transfers and daily risk
npm run rotation:release -- --confirm RELEASE-KILL-SWITCH

# Optional login task
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-rotation-task.ps1

# No-admin fallback: HKCU Run at current-user logon
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-rotation-autostart.ps1

# Remove the HKCU autostart entry
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-rotation-autostart.ps1
```

## Lifecycle rules

- A second watchdog exits with code `3`; the Windows file lock is released
  automatically if a process crashes.
- Exactly one executor and one scanner are expected. Matching excludes wrapper
  children so the old `tsx -> node` chain counts as one process tree.
- A healthy executor with a fresh matching heartbeat is adopted after a
  watchdog restart. A running executor without a fresh heartbeat produces
  `ATTENTION`; the watchdog does not start a duplicate.
- Executor exit `0` means a clean stop. Exit `2` means startup recovery or a
  safety gate blocked execution; the watchdog enters `BLOCKED` and does not
  restart-loop. Other exit codes use backoff.
- If the executor dies, the scanner is stopped first. The executor is restarted
  and must become heartbeat-ready before the scanner is restarted.
- A stale executor heartbeat restarts the whole trade pair. A stale scanner
  heartbeat restarts only the scanner.
- Duplicate executors trigger `npm run rotation:halt` (DB-only, no credentials)
  before any cleanup.
- The watchdog never clears `kill_switch` and never enables automatic execution
  by itself.

## Executor/scanner guards

- `--auto` requires `ARB_ROTATION_SUPERVISED=1`. Manual debugging must pass
  `--allow-unsupervised` and is intentionally not the production path.
- Both processes inherit `ARB_ROTATION_RUN_ID` and `ARB_ROTATION_STOP_FILE`.
- The executor checks the stop file between cycles and writes a stopped
  heartbeat when it exits.
- The scanner checks the stop file between scans and writes its own heartbeat.
- The executor uses a background heartbeat interval so a long FOK/reconcile
  step does not look like a dead process.

## Migration from the old wrapper

The old `start-rotation.ps1` wrapper used relative `tsx` arguments and had no
heartbeat. Do not start the new watchdog beside it.

```powershell
npm run rotation:halt
# wait for the old executor to finish its current batch and exit
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-rotation.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-rotation.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rotation-status.ps1
```

Acceptance after migration:

- exactly one executor and one scanner process;
- both heartbeats are fresh;
- `data/rotation-watchdog.status.json` says `RUNNING`;
- startup recovery reports no open execution, unresolved order or exchange open
  order;
- no stop file exists;
- account status is `WARN` (not `BLOCK`) with all unknown permission fields
  explicitly recorded.

## Current external limitations

- Gate and Hotcoin do not expose the key's current trade/withdraw permission
  bits. A real rejection is the final permission probe and must fail closed.
- The current Gate account has no IP whitelist. `require_ip_whitelist=false`
  records this as a WARN; setting it to true blocks until the whitelist is set.
- The watchdog is user-session software, not a Windows Service. The secret store
  uses a user-scoped DPAPI-wrapped master key; a service account would not see
  the same key.
- Task Scheduler registration requires administrator rights on this machine
  (the attempted registration returned `Access is denied`). The current-user
  HKCU Run entry is installed as the no-admin logon fallback. Either launcher is
  only a logon-time starter; the watchdog file lock and duplicate detection
  remain the source of truth.
