import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Reference project used to capture tool return shapes.
 *
 * The snapshot records structure only, but structure can still depend on the
 * environment: a tool that is present on the host PATH gains an `executable`
 * field. Every console script is therefore installed into the fixture
 * environment (in both the POSIX and the Windows script directory) so the
 * captured shapes do not depend on what the machine running the generator
 * happens to have installed.
 *
 * The contents are also chosen so that every array in every payload has at
 * least one element; an empty array would capture as `array<…>`.
 */
const PYPROJECT = `[project]
name = "ledger"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["requests>=2.31", "pytz>=2024.1"]

[project.optional-dependencies]
aws = ["boto3>=1.34"]

[dependency-groups]
dev = ["numpy>=2", "pytest>=8", "ruff>=0.6"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

/** `requests` is locked below the declared constraint on purpose, so the
 *  unsatisfied-specifier branch has a sample. */
const UV_LOCK = `version = 1
revision = 2
requires-python = ">=3.11"

[[package]]
name = "ledger"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "requests"
version = "2.30.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "numpy"
version = "2.1.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "9.1.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "ruff"
version = "0.16.8"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytz"
version = "2024.2"
source = { registry = "https://pypi.org/simple" }
`;

const CONSOLE_SCRIPTS = ['pytest', 'ruff', 'mypy', 'ty', 'pyright', 'pre-commit'];

const INSTALLED = [
  { directory: 'requests-2.30.0.dist-info', name: 'requests', version: '2.30.0' },
  { directory: 'pytest-9.1.1.dist-info', name: 'pytest', version: '9.1.1' },
  { directory: 'ruff-0.16.8.dist-info', name: 'ruff', version: '0.16.8' },
  { directory: 'pytz-2024.2.dist-info', name: 'pytz', version: '2024.2' },
];

export interface FixtureProject {
  root: string;
  cleanup(): Promise<void>;
}

export async function createFixtureProject(): Promise<FixtureProject> {
  const root = await mkdtemp(join(tmpdir(), 'py-api-surface-'));
  const venv = join(root, '.venv');
  const sitePackages = join(venv, 'lib', 'python3.12', 'site-packages');

  await mkdir(join(root, 'src', 'ledger'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await mkdir(sitePackages, { recursive: true });
  // Both script directories exist so the shape is identical on POSIX and
  // Windows, where the lookup order differs.
  for (const directory of [join(venv, 'bin'), join(venv, 'Scripts')]) {
    await mkdir(directory, { recursive: true });
    for (const name of CONSOLE_SCRIPTS) {
      const path = join(directory, name);
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o755);
    }
  }

  await writeFile(join(root, 'pyproject.toml'), PYPROJECT);
  await writeFile(join(root, 'uv.lock'), UV_LOCK);
  await writeFile(join(root, '.gitignore'), '.venv/\n');
  await writeFile(
    join(root, 'src', 'ledger', '__init__.py'),
    'from ledger.totals import total\n\n__all__ = ["total"]\n',
  );
  await writeFile(
    join(root, 'src', 'ledger', 'totals.py'),
    'def total(values: list[int]) -> int:\n    return sum(values)\n',
  );
  // Declared only in the dev group, imported from production code -> misplaced.
  await writeFile(join(root, 'src', 'ledger', 'stats.py'), 'import numpy\n');
  // Declared nowhere -> undeclared.
  await writeFile(join(root, 'src', 'ledger', 'upload.py'), 'import boto3\n');
  // Undeclared and guarded -> type-checking-only.
  await writeFile(
    join(root, 'src', 'ledger', 'frame.py'),
    'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    import pandas\n',
  );
  await writeFile(
    join(root, 'tests', 'test_totals.py'),
    'from ledger.totals import total\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n',
  );

  const editable = join(sitePackages, 'ledger-0.1.0.dist-info');
  await mkdir(editable, { recursive: true });
  await writeFile(join(editable, 'METADATA'), 'Name: ledger\nVersion: 0.1.0\n');
  await writeFile(
    join(editable, 'direct_url.json'),
    '{"url":"file:///proj","dir_info":{"editable":true}}',
  );

  for (const entry of INSTALLED) {
    const directory = join(sitePackages, entry.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'METADATA'),
      `Name: ${entry.name}\nVersion: ${entry.version}\n`,
    );
  }

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Bounded output with a project frame, so the diagnoser has something to show. */
export const FAILURE_SAMPLE = `============================= test session starts ==============================
collected 2 items

tests/test_totals.py F                                                   [ 50%]

=================================== FAILURES ===================================
_________________________________ test_total __________________________________

tests/test_totals.py:4: in test_total
    assert total([1, 2]) == 3
E   NameError: name 'total' is not defined
=========================== short test summary info ============================
FAILED tests/test_totals.py::test_total - NameError: name 'total' is not defined
========================= 1 failed, 1 passed in 0.21s =========================
`;
