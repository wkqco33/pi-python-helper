#!/usr/bin/env python3
"""Read-only Python project scanner used by pi-python-helper.

The extension shells out to this script because two of its questions cannot be
answered reliably from the outside:

* which imports a project actually uses (needs `ast`, not text search), and
* what `pyproject.toml` and `uv.lock` declare (needs a real TOML parser).

Protocol
--------
A JSON request is read from stdin and exactly one JSON document is written to
stdout. Human-readable diagnostics go to stderr. The script never writes to the
project and never imports project code, so it is safe to run against an
uninstalled checkout.

    usage: scan_project.py [--mode MODE] [--root DIR] [--max-files N]
                           [--help] [--version]

Exit codes:
    0  the scan completed and a result document was written to stdout
    1  an unexpected failure occurred (also reported as JSON on stdout)
    2  the arguments or the request were invalid
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from pathlib import Path

# Bumped whenever the request or the result document changes shape, so the
# caller can refuse to interpret a document it does not understand.
# 2: each scanned file reports `importModules`, the full dotted module names it
#    references, so test selection can map a test file to the module it imports.
SCANNER_VERSION = 2

KNOWN_SECTIONS = ("environment", "manifest", "imports")
EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2

EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    ".tox",
    ".nox",
    ".eggs",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".hypothesis",
    "node_modules",
    "build",
    "dist",
    "__pycache__",
    "site-packages",
    ".idea",
    ".vscode",
}

# Small fallback so the tool still classifies imports on Python < 3.10, where
# `sys.stdlib_module_names` does not exist. Only common modules are listed; an
# unknown name is reported as unclassified rather than assumed third-party.
FALLBACK_STDLIB = {
    "abc", "argparse", "ast", "asyncio", "base64", "collections", "concurrent",
    "contextlib", "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal",
    "difflib", "email", "enum", "errno", "faulthandler", "fnmatch", "fractions",
    "functools", "gc", "getpass", "glob", "gzip", "hashlib", "heapq", "hmac",
    "html", "http", "importlib", "inspect", "io", "ipaddress", "itertools",
    "json", "keyword", "linecache", "locale", "logging", "lzma", "math",
    "multiprocessing", "operator", "os", "pathlib", "pickle", "pkgutil",
    "platform", "plistlib", "pprint", "profile", "pstats", "queue", "random",
    "re", "secrets", "select", "shelve", "shlex", "shutil", "signal", "site",
    "smtplib", "socket", "sqlite3", "ssl", "stat", "statistics", "string",
    "struct", "subprocess", "sys", "tarfile", "tempfile", "textwrap",
    "threading", "time", "timeit", "token", "tokenize", "traceback", "tracemalloc",
    "types", "typing", "unittest", "urllib", "uuid", "venv", "warnings",
    "weakref", "webbrowser", "xml", "zipfile", "zlib", "zoneinfo", "__future__",
}

NAME_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")
NORMALIZE_RE = re.compile(r"[-_.]+")


def normalize(name: str) -> str:
    """PEP 503 name normalization: case and -/_/. are not significant."""
    return NORMALIZE_RE.sub("-", name).strip().lower()


def toml_module():
    try:
        import tomllib  # type: ignore[import-not-found]
        return tomllib, None
    except ModuleNotFoundError:
        pass
    try:
        import tomli  # type: ignore[import-not-found]
        return tomli, None
    except ModuleNotFoundError:
        return None, "no TOML parser available (needs Python 3.11+ or the tomli package)"


def load_toml(path: Path):
    module, error = toml_module()
    if module is None:
        return None, error
    try:
        with open(path, "rb") as handle:
            return module.load(handle), None
    except Exception as exc:  # malformed TOML is a diagnostic, not a crash
        return None, f"failed to parse {path.name}: {exc}"


def parse_requirement(raw):
    """Minimal PEP 508 split into name/specifier/extras/marker."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    marker = None
    if ";" in text:
        text, marker = text.split(";", 1)
    extras = []
    if "[" in text:
        head, rest = text.split("[", 1)
        extras_text, _, tail = rest.partition("]")
        extras = [item.strip() for item in extras_text.split(",") if item.strip()]
        text = head + tail
    match = NAME_RE.match(text)
    if not match:
        return None
    name = match.group(1)
    return {
        "raw": raw,
        "name": name,
        "normalized": normalize(name),
        "specifier": text[match.end():].strip(),
        "extras": extras,
        "marker": marker.strip() if marker else None,
    }


def parse_requirement_list(entries):
    if not isinstance(entries, list):
        return []
    parsed = []
    for entry in entries:
        if not isinstance(entry, str):
            continue  # dependency-groups also allows {include-group = "..."}
        item = parse_requirement(entry)
        if item:
            parsed.append(item)
    return parsed


def safe_is_file(path: Path) -> bool:
    """Stat without raising.

    A single unreadable directory (for example a root-owned `/tmp` sibling)
    must never abort the whole scan, so every probe degrades to False.
    """
    try:
        return path.is_file()
    except OSError:
        return False


def safe_is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def safe_iterdir(path: Path) -> list:
    try:
        return sorted(path.iterdir())
    except OSError:
        return []


def contains_python(path: Path, limit: int = 400) -> bool:
    """True when the directory actually holds Python code.

    A directory under `src/` is only an importable module when it contains
    Python. Without this check a TypeScript or JavaScript tree that happens to
    live under `src/` would be reported as a Python package. The walk is bounded
    so a deep tree cannot make layout detection expensive.
    """
    if safe_is_file(path / "__init__.py"):
        return True
    seen = 0
    stack = [path]
    while stack and seen < limit:
        current = stack.pop()
        for entry in safe_iterdir(current):
            seen += 1
            if entry.name in EXCLUDED_DIRS:
                continue
            if entry.is_dir():
                stack.append(entry)
            elif entry.is_file() and entry.suffix == ".py":
                return True
    return False


def detect_layout(root: Path) -> tuple[str, list[str]]:
    """Return the layout kind and the top-level importable module names."""
    modules: list[str] = []
    src = root / "src"
    if safe_is_dir(src):
        layout = "src"
        for entry in safe_iterdir(src):
            if entry.is_dir() and entry.name not in EXCLUDED_DIRS and contains_python(entry):
                modules.append(entry.name)
            elif entry.is_file() and entry.suffix == ".py" and entry.stem != "__init__":
                modules.append(entry.stem)
    else:
        layout = "flat"
        for entry in safe_iterdir(root):
            if entry.name in EXCLUDED_DIRS:
                continue
            if entry.is_dir() and safe_is_file(entry / "__init__.py"):
                modules.append(entry.name)
            elif entry.is_file() and entry.suffix == ".py":
                modules.append(entry.stem)
    return layout, sorted(set(modules))


def scan_manifests(root: Path) -> dict:
    result: dict = {
        "pyprojectPath": None,
        "name": None,
        "version": None,
        "requiresPython": None,
        "description": None,
        "license": None,
        "dependencies": [],
        "optionalDependencies": {},
        "dependencyGroups": {},
        "buildBackend": None,
        "buildRequires": [],
        "entryPoints": [],
        "toolConfiguration": {},
        "layout": None,
        "modules": [],
        "legacySetupPy": False,
        "legacySetupCfg": False,
        "requirementsFiles": [],
        "uvWorkspaceMembers": [],
        "uvSources": [],
        "warnings": [],
    }

    layout, modules = detect_layout(root)
    result["layout"] = layout
    result["modules"] = modules

    project_name = None
    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        result["pyprojectPath"] = str(pyproject)
        data, error = load_toml(pyproject)
        if error:
            result["warnings"].append(error)
            result["tomlError"] = error
        elif data is not None:
            project = data.get("project") if isinstance(data.get("project"), dict) else {}
            project_name = project.get("name")
            result["name"] = project_name
            result["version"] = project.get("version")
            result["requiresPython"] = project.get("requires-python")
            result["description"] = project.get("description")
            license_value = project.get("license")
            if isinstance(license_value, dict):
                license_value = license_value.get("text") or license_value.get("file")
            result["license"] = license_value
            result["dependencies"] = parse_requirement_list(project.get("dependencies"))
            optional = project.get("optional-dependencies")
            if isinstance(optional, dict):
                result["optionalDependencies"] = {
                    key: parse_requirement_list(value) for key, value in optional.items()
                }
            scripts = project.get("scripts")
            gui_scripts = project.get("gui-scripts")
            for table in (scripts, gui_scripts):
                if isinstance(table, dict):
                    result["entryPoints"].extend(sorted(table.keys()))
            build_system = data.get("build-system")
            if isinstance(build_system, dict):
                result["buildBackend"] = build_system.get("build-backend")
                result["buildRequires"] = [
                    item.get("name")
                    for item in parse_requirement_list(build_system.get("requires"))
                ]
            groups = data.get("dependency-groups")
            if isinstance(groups, dict):
                result["dependencyGroups"] = {
                    key: parse_requirement_list(value) for key, value in groups.items()
                }
            tool = data.get("tool") if isinstance(data.get("tool"), dict) else {}
            result["toolConfiguration"] = {
                key: key in tool
                for key in ("ruff", "mypy", "pytest", "coverage", "pyright", "ty", "hatch")
            }
            uv_table = tool.get("uv") if isinstance(tool.get("uv"), dict) else {}
            workspace = uv_table.get("workspace") if isinstance(uv_table.get("workspace"), dict) else {}
            members = workspace.get("members")
            result["uvWorkspaceMembers"] = [m for m in members if isinstance(m, str)] if isinstance(members, list) else []
            sources = uv_table.get("sources")
            result["uvSources"] = sorted(sources.keys()) if isinstance(sources, dict) else []
    else:
        result["warnings"].append("pyproject.toml was not found at the project root.")

    result["legacySetupPy"] = safe_is_file(root / "setup.py")
    result["legacySetupCfg"] = safe_is_file(root / "setup.cfg")
    result["requirementsFiles"] = sorted(
        entry.name
        for entry in safe_iterdir(root)
        if entry.name.startswith("requirements")
        and entry.name.endswith(".txt")
        and safe_is_file(entry)
    )
    if project_name:
        result["importName"] = normalize(project_name).replace("-", "_")
    return result


def parse_lock_dependencies(entry) -> list:
    """Edges of a locked package, keeping the marker that guards each one.

    uv writes platform and version conditions here (for example
    `{ name = "colorama", marker = "sys_platform == 'win32'" }`). A locked
    package that is only ever referenced behind a marker must not be reported as
    missing from the environment on a platform where the marker is false.
    """
    raw = entry.get("dependencies")
    if not isinstance(raw, list):
        return []
    edges = []
    for dependency in raw:
        if isinstance(dependency, str):
            name = dependency
            marker = None
        elif isinstance(dependency, dict) and isinstance(dependency.get("name"), str):
            name = dependency["name"]
            marker = dependency.get("marker")
        else:
            continue
        edges.append(
            {
                "name": name,
                "normalized": normalize(name),
                "marker": marker.strip() if isinstance(marker, str) and marker.strip() else None,
            }
        )
    return edges


def scan_lock(root: Path) -> dict:
    uv_lock = root / "uv.lock"
    result: dict = {
        "path": str(uv_lock) if uv_lock.is_file() else None,
        "present": uv_lock.is_file(),
        "version": None,
        "revision": None,
        "requiresPython": None,
        "packages": [],
        "warnings": [],
    }
    if not uv_lock.is_file():
        poetry_lock = root / "poetry.lock"
        if poetry_lock.is_file():
            result["warnings"].append(
                "poetry.lock was found; this package targets uv, so only uv.lock is analysed."
            )
        return result
    data, error = load_toml(uv_lock)
    if error:
        result["warnings"].append(error)
        return result
    if not isinstance(data, dict):
        result["warnings"].append("uv.lock did not contain a table.")
        return result
    result["version"] = data.get("version")
    result["revision"] = data.get("revision")
    result["requiresPython"] = data.get("requires-python")
    packages = data.get("package")
    if isinstance(packages, list):
        for entry in packages:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                continue
            source = entry.get("source")
            source_kind = None
            if isinstance(source, dict):
                source_kind = next(iter(source.keys()), None)
            result["packages"].append(
                {
                    "name": entry.get("name"),
                    "normalized": normalize(entry["name"]),
                    "version": entry.get("version"),
                    "source": source_kind,
                    "dependencies": parse_lock_dependencies(entry),
                }
            )
    return result


def compare_lock(lock: dict, manifest: dict) -> dict:
    """Report lockfile drift for the direct dependencies only.

    Transitive packages legitimately exist in the lock without being declared,
    so only the declared set is checked. `packaging` is optional: without it the
    specifier comparison is skipped and reported as unavailable.
    """
    report = {
        "specifierCheckAvailable": False,
        "missingFromLock": [],
        "unsatisfiedInLock": [],
        "requiresPythonMismatch": None,
        "checkedCount": 0,
    }
    if not lock.get("present"):
        return report
    declared = list(manifest.get("dependencies") or [])
    for group in (manifest.get("optionalDependencies") or {}).values():
        declared.extend(group)
    declared = [item for item in declared if isinstance(item, dict)]
    index = {}
    for package in lock.get("packages") or []:
        index.setdefault(package.get("normalized"), package)

    manifest_python = manifest.get("requiresPython")
    lock_python = lock.get("requiresPython")
    if manifest_python and lock_python and manifest_python != lock_python:
        report["requiresPythonMismatch"] = {
            "manifest": manifest_python,
            "lock": lock_python,
        }

    try:
        from packaging.requirements import Requirement
        from packaging.version import InvalidVersion, Version
    except Exception:
        # `packaging` is an optional analyser dependency. It may be missing, or
        # present but broken, and either way the scan must continue with the
        # weaker name-only comparison instead of failing.
        for item in declared:
            if item["normalized"] not in index:
                report["missingFromLock"].append(item["name"])
        report["checkedCount"] = len(declared)
        return report

    report["specifierCheckAvailable"] = True
    for item in declared:
        entry = index.get(item["normalized"])
        if entry is None:
            report["missingFromLock"].append(item["name"])
            continue
        version = entry.get("version")
        if not version or not item["specifier"]:
            continue
        try:
            requirement = Requirement(item["raw"])
            if not requirement.specifier:
                continue
            satisfied = requirement.specifier.contains(Version(version), prereleases=True)
        except Exception:
            continue
        if not satisfied:
            report["unsatisfiedInLock"].append(
                {
                    "name": item["name"],
                    "specifier": item["specifier"],
                    "locked": version,
                }
            )
    report["checkedCount"] = len(declared)
    return report


def installed_providers() -> dict:
    """Map top-level import name -> distributions providing it (host env only)."""
    try:
        from importlib.metadata import packages_distributions

        return {
            module: sorted(set(distributions))
            for module, distributions in packages_distributions().items()
        }
    except Exception:
        return {}

def _is_type_checking_test(test) -> bool:
    """Recognize `if TYPE_CHECKING:` and `if typing.TYPE_CHECKING:` guards.

    Imports behind that guard only need to exist for type checkers, so they must
    never be reported as a missing runtime dependency.
    """
    if isinstance(test, ast.Name):
        return test.id == "TYPE_CHECKING"
    if isinstance(test, ast.Attribute):
        return test.attr == "TYPE_CHECKING"
    return False


class ImportCollector(ast.NodeVisitor):
    """Collect top-level import names and the full dotted modules they reference."""

    def __init__(self) -> None:
        self.all: set[str] = set()
        self.type_checking: set[str] = set()
        self.modules: set[str] = set()
        self._guard_depth = 0

    def _record(self, name: str) -> None:
        if not name:
            return
        self.all.add(name)
        if self._guard_depth > 0:
            self.type_checking.add(name)

    def visit_If(self, node: ast.If) -> None:
        guarded = _is_type_checking_test(node.test)
        if guarded:
            self._guard_depth += 1
        for child in node.body:
            self.visit(child)
        if guarded:
            self._guard_depth -= 1
        for child in node.orelse:
            self.visit(child)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._record(alias.name.split(".")[0])
            self.modules.add(alias.name)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level:  # relative import -> always local
            for alias in node.names:
                self.modules.add(alias.name)
            return
        if node.module:
            self._record(node.module.split(".")[0])
            self.modules.add(node.module)
            # `from pkg.db import database` names a submodule, not the package,
            # so both spellings are recorded and either can match a change.
            for alias in node.names:
                self.modules.add(f"{node.module}.{alias.name}")


def scan_imports(root: Path, max_files: int) -> dict:
    stdlib_available = hasattr(sys, "stdlib_module_names")
    stdlib = set(getattr(sys, "stdlib_module_names", FALLBACK_STDLIB)) | {"__future__"}
    layout, local_modules = detect_layout(root)
    local = set(local_modules) | {"conftest", "setup", "__main__"}

    providers = installed_providers()
    files = []
    unparsable = []
    truncated = False
    by_import: dict[str, list[str]] = {}
    guarded_by_import: dict[str, list[str]] = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in EXCLUDED_DIRS and not name.endswith(".egg-info")
        )
        for filename in sorted(filenames):
            if not filename.endswith(".py"):
                continue
            if len(files) >= max_files:
                truncated = True
                dirnames[:] = []
                break
            path = Path(dirpath) / filename
            relative = os.path.relpath(path, root)
            try:
                source = path.read_text(encoding="utf-8", errors="replace")
                tree = ast.parse(source, filename=relative)
            except SyntaxError as exc:
                unparsable.append({"path": relative, "error": f"SyntaxError: {exc.msg}"})
                continue
            except (OSError, ValueError) as exc:
                unparsable.append({"path": relative, "error": str(exc)})
                continue
            collector = ImportCollector()
            collector.visit(tree)
            names = collector.all
            names.discard("")
            files.append(
                {
                    "path": relative,
                    "imports": sorted(names),
                    "importModules": sorted(collector.modules),
                    "typeCheckingImports": sorted(collector.type_checking),
                }
            )
            for name in names:
                by_import.setdefault(name, []).append(relative)
                if name in collector.type_checking:
                    guarded_by_import.setdefault(name, []).append(relative)

    third_party = []
    for name in sorted(by_import):
        if name in stdlib or name in local:
            continue
        importers = sorted(by_import[name])
        guarded = guarded_by_import.get(name, [])
        third_party.append(
            {
                "import": name,
                "files": importers[:20],
                "fileCount": len(importers),
                "providers": providers.get(name, []),
                "typeCheckingOnly": bool(guarded) and len(guarded) == len(importers),
                "typeCheckingFiles": guarded[:20],
            }
        )

    return {
        "pythonVersion": sys.version.split()[0],
        "stdlibAvailable": stdlib_available,
        "layout": layout,
        "localModules": sorted(local),
        "files": files,
        "thirdParty": third_party,
        "providersUnavailable": not bool(providers),
        "unparsable": unparsable,
        "scannedFiles": len(files),
        "truncated": truncated,
    }


def describe_environment(root: Path) -> dict:
    """Describe the interpreter that is running this script.

    The extension resolves an interpreter first and then asks it about itself,
    so `sys.executable` here is the interpreter the project commands will use.
    """
    base_prefix = getattr(sys, "base_prefix", sys.prefix)
    venv_dir = os.environ.get("VIRTUAL_ENV")
    if not venv_dir:
        local_venv = root / ".venv"
        if local_venv.is_dir():
            venv_dir = str(local_venv)
    return {
        "version": sys.version.split()[0],
        "versionInfo": list(sys.version_info[:3]),
        "executable": sys.executable,
        "prefix": sys.prefix,
        "basePrefix": base_prefix,
        "inVirtualEnvironment": sys.prefix != base_prefix,
        "virtualEnv": os.environ.get("VIRTUAL_ENV"),
        "condaPrefix": os.environ.get("CONDA_PREFIX"),
        "candidateVenvDir": venv_dir,
        "implementation": sys.implementation.name,
        "platform": sys.platform,
        "stdlibModuleNames": hasattr(sys, "stdlib_module_names"),
        "tomlAvailable": toml_module()[0] is not None,
    }


def parse_arguments(argv: list) -> tuple[argparse.Namespace | None, int]:
    """Parse CLI flags. Every value also arrives through the stdin request."""
    parser = argparse.ArgumentParser(
        prog="scan_project.py",
        description=(
            "Read-only Python project scanner. A JSON request is read from stdin and "
            "one JSON document is written to stdout; diagnostics go to stderr."
        ),
        epilog=(
            "exit codes: 0 success, 1 unexpected failure, 2 invalid input. "
            "Sections: environment, manifest, imports, all."
        ),
    )
    parser.add_argument(
        "--mode",
        default=None,
        help="Comma-separated sections to scan (environment,manifest,imports) or all.",
    )
    parser.add_argument("--root", default=None, help="Project root; defaults to the cwd.")
    parser.add_argument("--max-files", type=int, default=None, help="Cap on scanned Python files.")
    parser.add_argument(
        "--version",
        action="version",
        version=f"scan_project.py (scanner protocol {SCANNER_VERSION})",
    )
    try:
        return parser.parse_args(argv), EXIT_OK
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else EXIT_USAGE
        return None, (EXIT_OK if code == 0 else EXIT_USAGE)


def resolve_sections(raw) -> list:
    """Expand a mode value into known sections, rejecting unknown ones."""
    if raw is None or raw == "" or raw == "all":
        return list(KNOWN_SECTIONS)
    if not isinstance(raw, str):
        raise ValueError(f"mode must be a string, got {type(raw).__name__}")
    requested = [part.strip() for part in raw.split(",") if part.strip()]
    if not requested:
        raise ValueError("mode must not be empty")
    if "all" in requested:
        return list(KNOWN_SECTIONS)
    unknown = [part for part in requested if part not in KNOWN_SECTIONS]
    if unknown:
        raise ValueError(
            f"unknown mode section(s): {', '.join(unknown)}; expected {', '.join(KNOWN_SECTIONS)} or all"
        )
    # Preserve canonical order so the document layout does not depend on input order.
    return [section for section in KNOWN_SECTIONS if section in requested]


def fail(message: str, code: int) -> int:
    """Report a problem on stdout and stderr: stdout stays machine-readable."""
    print(json.dumps({"error": message}))
    print(f"scan_project.py: {message}", file=sys.stderr)
    return code


def main(argv: list | None = None) -> int:
    args, argument_code = parse_arguments(list(sys.argv[1:] if argv is None else argv))
    if args is None:
        return argument_code

    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        return fail(f"invalid request JSON: {exc}", EXIT_USAGE)
    if not isinstance(request, dict):
        return fail("the request must be a JSON object", EXIT_USAGE)

    # Explicit flags take precedence over the request, then the defaults.
    raw_mode = args.mode if args.mode is not None else request.get("mode")
    raw_root = args.root if args.root is not None else request.get("root")
    raw_max = args.max_files if args.max_files is not None else request.get("maxFiles")
    try:
        sections = resolve_sections(raw_mode)
    except ValueError as exc:
        return fail(str(exc), EXIT_USAGE)
    try:
        max_files = int(raw_max if raw_max is not None else 2000)
    except (TypeError, ValueError):
        return fail(f"maxFiles must be an integer, got {raw_max!r}", EXIT_USAGE)
    if max_files < 1:
        return fail("maxFiles must be at least 1", EXIT_USAGE)

    root = Path(raw_root or os.getcwd()).resolve()
    if not root.is_dir():
        return fail(f"not a directory: {root}", EXIT_USAGE)

    payload: dict = {
        "scannerVersion": SCANNER_VERSION,
        "root": str(root),
        "mode": ",".join(sections),
        "pythonVersion": sys.version.split()[0],
        "tomlAvailable": toml_module()[0] is not None,
    }
    if "environment" in sections:
        payload["environment"] = describe_environment(root)
    if "manifest" in sections:
        payload["manifest"] = scan_manifests(root)
        payload["lock"] = scan_lock(root)
        payload["lockComparison"] = compare_lock(payload["lock"], payload["manifest"])
    if "imports" in sections:
        payload["imports"] = scan_imports(root, max_files)

    print(json.dumps(payload))
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(EXIT_FAILURE)
    except Exception as exc:  # a crash must still reach the caller as structured JSON
        sys.exit(fail(f"scanner failed: {type(exc).__name__}: {exc}", EXIT_FAILURE))
