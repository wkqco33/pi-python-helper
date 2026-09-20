# Security Policy

## Supported versions

Security fixes target the latest released version and the `main` branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private security advisory flow for `wkqco33/pi-python-helper` when available. Include reproduction steps, affected version, and impact. Do not include credentials, virtual environments, or private source trees.

## Safety model

This extension inspects Python projects and can run environment-modifying commands. The following guarantees hold:

- No tool in this package writes, moves, or deletes project files.
- `py_sync` and `py_validation_bundle` return a preview and execute nothing unless `execute: true` is explicitly passed.
- Every subprocess is bounded by a timeout, an abort signal, and an output size cap.
- User-supplied paths and package names are passed as argument arrays, never interpolated into a shell string.
- `uv --frozen` is used for test runs so a test invocation cannot silently rewrite `uv.lock`.
- `helpers/scan_project.py` is read-only: it never imports project code and never writes to disk.

`execute: true` on `py_sync` or `py_validation_bundle` creates or refreshes `.venv`. Do not bypass that gate in automation unless the deployment environment has an independently reviewed authorization layer.

Irreversible operations (publishing to an index, force pushing, hard resetting, recursive deletion, reversing migrations) are classified and reported with a reason. This extension never runs them on your behalf.
