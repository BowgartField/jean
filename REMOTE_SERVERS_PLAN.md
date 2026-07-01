# Remote Servers — run Jean sessions on a cloud box over SSH

## Context

Before this work, Jean ran AI sessions, terminals, git, and file operations
only on the machine hosting the desktop app. Remote server support now lets the
user register a Linux server and run project-scoped work on it while local and
remote sessions coexist in the same window.

Key enabling fact discovered during exploration: Jean **already** ships a headless server mode (`jean --headless --host --port --token`, `lib.rs:3433`+, `start_http_server_headless`) that exposes the entire command surface over HTTP+WebSocket (`http_server/dispatch.rs`), and the frontend (`src/lib/transport.ts`) **already** has a `WsTransport` client used for "web access". So a remote session = a headless Jean on the cloud box, reached through an **SSH tunnel**, driven by a second `WsTransport`. PTY terminals, detached Claude, the Pi RPC socket, and Codex stdio all "just work" remotely because they are _local_ from the remote backend's perspective.

The implementation was delivered in three phases. The primary Claude flow has
been validated end to end on a provisioned Linux server.

## Decisions (locked)

- **1b** Mixed local + remote sessions in one window.
- **2a** SSH via the **system `ssh`/`scp`** binary (ControlMaster, `-L`/`-R`), not a Rust SSH crate.
- **3b** Jean **auto-provisions** the server: check/install OpenSSH server, install Jean as a service, start it headless. Jean does **not** manage server OS updates.
- **4a** AI CLIs authenticate **on the server** (user runs `claude login` etc. via the remote terminal).

## Headless runtime

Jean's current headless entrypoint clears the window configuration, but Tauri's
Linux event loop still initializes GTK first. Provisioning therefore runs the
signed AppImage through `xvfb-run` until the server is decoupled from
`tauri::Builder`. The standalone `jean-server` entrypoint has the same GTK
initialization requirement.

---

## Architecture

```
Desktop Jean (client)
  ├─ Local backend     → native Tauri IPC            (unchanged, default)
  └─ Remote server "S" → WsTransport over SSH tunnel  → headless Jean on S
        ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> user@S
        (remote Jean binds 127.0.0.1 only — exposed solely through the tunnel)
```

A **remote project** is a project whose data lives on server S. Every operation on that project's worktrees/sessions/terminals/git/files routes to S's `WsTransport`. Local projects keep using native IPC. Routing granularity = **the server that owns the active project**, threaded as a backend handle.

---

## Phase 1 — Server management + provisioning + tunnel (backend foundation)

**Implementation status (2026-06-30): complete and manually validated.**
Backend persistence, IPC/WebSocket dispatch, signed artifact provisioning,
tunnel lifecycle, tests, and developer documentation are implemented. A real
Linux server was provisioned, connected, and used for the complete remote
Claude workflow.

New Rust module `src-tauri/src/remote/` :

- `types.rs` — `RemoteServerConfig { id, name, host, port, username, auth: SshKeyPath|Password, default, status }`. Mirror in `src/types/remote.ts` (snake_case).
- Storage: add `remote_servers: Vec<RemoteServerConfig>` to `AppPreferences` (`lib.rs`), same pattern as `custom_cli_profiles`. Secrets: store key path / reference; if password, keep it out of plain `preferences.json` where possible (note as a follow-up; MVP may store but flag it).
- `ssh.rs` — thin wrappers over `silent_command("ssh"|"scp")` (reuse `platform::process::silent_command`):
  - `test_connection(server)` — `ssh -o BatchMode ... echo ok`.
  - `exec(server, cmd)` — run a remote command, capture stdout/stderr.
  - Use a per-server **ControlMaster** socket (`-o ControlPath=<appdata>/ssh/<id>.sock -o ControlPersist`) so subsequent calls multiplex one auth'd connection.
- `provision.rs` — idempotent setup over `exec`:
  1. Detect distro / privilege (sudo).
  2. Ensure OpenSSH server present (it must be, since we're already SSH'd in — really this is "ensure sshd + runtime deps").
  3. Install Xvfb and WebKitGTK/GTK runtime deps.
  4. Download Jean Linux artifact to the server. Resolve the release manifest matching the desktop's exact version, verify its updater minisign signature with the public key from `tauri.conf.json`, and extract the `.tar.gz`/AppImage with `tar`+`flate2`. Source: GitHub releases (`coollabsio/jean`). Pick artifact by remote arch (`uname -m`).
  5. Generate an auth **token**, write a **systemd unit** that runs `xvfb-run -a <jean> --headless --host 127.0.0.1 --port <P> --token <T>`; `systemctl enable --now`, then wait for the authenticated API endpoint.
- `tunnel.rs` — manage `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<P>` as a tracked child in a registry (mirror `terminal/registry.rs`). Optional `-R <remote>:127.0.0.1:<local>` reverse forwards for testing remote services locally. Health check: poll `http://127.0.0.1:<localPort>/...` with the token.
- Tauri commands (register in **both** `lib.rs generate_handler!` and `http_server/dispatch.rs`): `add_remote_server`, `update_remote_server`, `remove_remote_server`, `list_remote_servers`, `test_remote_server`, `provision_remote_server`, `connect_remote_server` (open tunnel, return `{localPort, token}`), `disconnect_remote_server`, `get_remote_server_status`.

Phase-1 acceptance: from a terminal you can `connect`, then hit the tunneled headless Jean (curl health) — backend only.

## Phase 2 — Client transport routing (the 1b core)

**Implementation status (2026-06-30): complete.**

- `src/lib/transport.ts` maintains a `WsTransport` registry keyed by server ID.
- `_backendHandle` routes project-scoped commands to the owning remote backend.
- Remote events retain their backend origin so identical local and remote IDs
  cannot cross-route updates.
- Transport registration waits for the WebSocket open event instead of using a
  fixed delay.
- Project, worktree, session, chat, terminal, git, and file operations route
  through the owning backend while global settings remain local.
- Remote session lifecycle operations, including send, close, archive, cancel,
  and resume, use the worktree's persisted server mapping.

Phase-2 acceptance: open a remote project → its worktree list, a chat session, and a terminal all run on the server; a local session in another tab still works simultaneously.

## Phase 3 — Remote project lifecycle + polish

**Implementation status (2026-06-30): primary lifecycle complete.**

- Projects can be cloned to a selected server with SSH config alias resolution,
  identity loading, and agent forwarding.
- Worktrees can be created directly on a selected remote backend.
- The server settings UI supports add, edit, test, provision, connect,
  disconnect, status, and remote Claude login.
- Provisioned servers auto-connect on startup. Worktree queries are refreshed
  only after both the SSH tunnel and WebSocket are ready, so existing remote
  worktrees reappear after restarting Jean.
- Existing remote chat sessions preserve their backend mapping and resume after
  restart.
- Reverse port-forwarding UI remains a follow-up.

---

## Key files

- New: `src-tauri/src/remote/{mod,types,ssh,provision,tunnel,commands}.rs`; `src/types/remote.ts`; `src/components/preferences/panes/RemoteServersPane.tsx`.
- Edit: `src-tauri/src/lib.rs` (AppPreferences + handler registration), `src-tauri/src/http_server/dispatch.rs` (dispatch arms), `src-tauri/src/projects/types.rs` + `src/types/projects.ts` (`server_id`), `src/lib/transport.ts` (transport registry + routing), `src/hooks/useStreamingEvents.ts`, `src/lib/terminal-instances.ts`, `src/components/preferences/PreferencesDialog.tsx`, `src/components/projects/panes/GeneralPane.tsx`.
- Reuse: `platform::process::silent_command` (ssh/scp), the Tauri updater minisign verification pattern, registry pattern from `terminal/registry.rs`, `WsTransport` from `transport.ts`.

## Out of scope (MVP)

- Server OS/Jean auto-updates (user-managed, per 3b).
- Pure-Rust SSH, SFTP file browser, multi-user servers.
- A true headless runtime decoupled from Tauri's GTK event loop.
- Encrypted-at-rest password vault (flag as security follow-up).

## Risks

- **Virtual display dependency** — remove Xvfb only after a server binary starts successfully with both `DISPLAY` and `WAYLAND_DISPLAY` unset.
- **Version skew** — client and remote headless Jean must speak the same dispatch protocol; pin/verify versions on connect.
- **Secret handling** — SSH password / token storage in `preferences.json` is a security concern; prefer key-based auth and OS keychain later.
- **Routing leakage** — a remote-project call that forgets its `_backendHandle` silently hits the local backend; add a dev assertion when a remote project is active.

## Verification status

- Completed on a real Linux server: provision, connect, remote clone, remote
  worktree creation, Claude login, chat prompt/response, Jean restart,
  worktree rediscovery, and chat resume.
- Automated coverage includes provisioning and SSH command construction,
  transport routing and readiness, reconnect cache invalidation, remote Claude
  authentication, server settings, remote chat lifecycle routing, tunnel
  recreation after an SSH child failure, and stream replay after the local
  tunnel port changes.
- Docker integration coverage starts a real SSH forward, kills it, recreates it
  on another local port, and verifies WebSocket event replay.
- Lima integration coverage invokes the real server-management commands against
  a systemd Linux VM and verifies the signed AppImage install, Xvfb/WebKitGTK
  dependencies, service health, authenticated tunnel, and WebSocket dispatch.
- Remaining release-hardening scenarios: concurrent local and remote sessions,
  remote terminal execution, other AI backends, and the supported
  Linux/platform matrix.
