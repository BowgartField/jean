# Platform-specific CI tests

## Context

The shared Rust test suite currently runs once on Ubuntu before the native
platform builds. The platform build matrix compiles the application for Linux,
macOS, and Windows, but there is no dedicated runtime test suite for behavior
that differs by operating system.

At the time this task was created:

- Seven active tests are gated by `cfg(unix)` or `cfg(not(windows))` and already
  run on Ubuntu.
- One additional Unix-only end-to-end test is ignored by default.
- There are no tests explicitly gated for Windows or macOS.

## Goal

Add focused Windows and macOS test coverage without rerunning the entire common
Rust suite in every platform build.

## Suggested approach

- Introduce a clear naming, module, or Cargo feature convention for
  platform-specific tests.
- Run only the matching platform test group in each native build job.
- Keep the complete common Rust suite in the shared Ubuntu test job.
- Cover platform process spawning, path handling, shell behavior, and native
  integrations first.
