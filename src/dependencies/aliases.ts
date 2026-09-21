/**
 * Import name and distribution name frequently disagree. The scanner supplies
 * the authoritative mapping when the analysing interpreter has the package
 * installed; this table covers the cases where it does not, so an uninstalled
 * checkout is still analysed correctly.
 */
export const IMPORT_ALIASES: Record<string, string[]> = {
  PIL: ['pillow'],
  yaml: ['pyyaml'],
  dateutil: ['python-dateutil'],
  bs4: ['beautifulsoup4'],
  cv2: ['opencv-python', 'opencv-python-headless'],
  sklearn: ['scikit-learn'],
  skimage: ['scikit-image'],
  dotenv: ['python-dotenv'],
  attr: ['attrs'],
  attrs: ['attrs'],
  jwt: ['pyjwt'],
  jose: ['python-jose'],
  serial: ['pyserial'],
  OpenSSL: ['pyopenssl'],
  Crypto: ['pycryptodome'],
  pkg_resources: ['setuptools'],
  MySQLdb: ['mysqlclient'],
  googleapiclient: ['google-api-python-client'],
  github: ['PyGithub'],
  pytest_cov: ['pytest-cov'],
  _pytest: ['pytest'],
  pytest_asyncio: ['pytest-asyncio'],
  psycopg: ['psycopg', 'psycopg-binary'],
  psycopg2: ['psycopg2', 'psycopg2-binary'],
  prometheus_client: ['prometheus-client'],
  grpc: ['grpcio'],
  kafka: ['kafka-python'],
  docker: ['docker'],
  numpy: ['numpy'],
  pandas: ['pandas'],
  ruamel: ['ruamel.yaml'],
  setuptools: ['setuptools'],
  mako: ['Mako'],
  pytz: ['pytz'],
  tzlocal: ['tzlocal'],
  win32com: ['pywin32'],
  lxml: ['lxml'],
  matplotlib: ['matplotlib'],
  seaborn: ['seaborn'],
  sqlalchemy: ['sqlalchemy', 'SQLAlchemy'],
  pydantic: ['pydantic'],
  fastapi: ['fastapi'],
  starlette: ['starlette'],
  uvicorn: ['uvicorn'],
  celery: ['celery'],
  redis: ['redis'],
  boto3: ['boto3'],
  botocore: ['botocore'],
  httpx: ['httpx'],
  aiohttp: ['aiohttp'],
  werkzeug: ['werkzeug'],
  flask: ['flask'],
  django: ['django'],
  jinja2: ['jinja2'],
  typer: ['typer'],
  click: ['click'],
  rich: ['rich'],
  tqdm: ['tqdm'],
};

const NORMALIZE_RE = /[-_.]+/g;

/**
 * Distribution candidates for an import name, from the static alias table only.
 *
 * Used where the scanner cannot supply the authoritative provider mapping (a
 * traceback names an import, not an installed distribution). Ordering is
 * preserved so a caller can name every candidate when an import maps to more
 * than one distribution: `cv2` is either `opencv-python` or
 * `opencv-python-headless`, and picking one silently would install the wrong
 * variant. An empty result means the provider is unknown, and no `uv add`
 * command may be fabricated from the import name.
 */
export function importAliasCandidates(importName: string): string[] {
  const normalized = importName.replace(NORMALIZE_RE, '-').trim().toLowerCase();
  const candidates = new Set<string>();
  for (const alias of IMPORT_ALIASES[importName] ?? []) candidates.add(alias);
  for (const alias of IMPORT_ALIASES[normalized] ?? []) candidates.add(alias);
  return [...candidates];
}

/** Distributions that are normally invoked as a console script, not imported. */
export const CONSOLE_ONLY: Set<string> = new Set([
  'ruff',
  'mypy',
  'pyright',
  'ty',
  'pytest',
  'pytest-cov',
  'coverage',
  'pre-commit',
  'tox',
  'nox',
  'hatch',
  'hatchling',
  'build',
  'twine',
  'black',
  'isort',
  'flake8',
  'pylint',
  'sphinx',
  'mkdocs',
  'uvicorn',
  'gunicorn',
  'alembic',
  'celery',
  'honcho',
  'maturin',
  'setuptools-scm',
  'pip-audit',
  'bandit',
  'commitizen',
  'towncrier',
]);
