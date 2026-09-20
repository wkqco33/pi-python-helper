import { describeSamples, describeValue, renderShape, type ShapeNode } from './shape.ts';
import { FAILURE_SAMPLE, createFixtureProject } from './fixture.ts';
import { resolveInterpreter } from '../../src/project/scanner.ts';
import { runCommand } from '../../src/core/runner.ts';
import register from '../../extensions/index.ts';

export interface JsonSchema {
  type?: string;
  const?: unknown;
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}

export interface ToolLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: JsonSchema;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: { cwd: string },
  ) => Promise<{ details?: unknown }>;
}

export interface ParameterSurface {
  type: string;
  required: boolean;
  description?: string;
  constraints?: string;
}

export interface ToolSurface {
  label: string;
  parameters: Record<string, ParameterSurface>;
  /** Absent when the snapshot was produced without capturing return values. */
  data?: ShapeNode;
}

export interface ApiSurfaceSnapshot {
  generator: string;
  note: string;
  /** The exact parameters used for each captured tool. */
  capture?: Record<string, Record<string, unknown>>;
  envelope?: ShapeNode;
  tools: Record<string, ToolSurface>;
}

export const SNAPSHOT_NOTE =
  'Structure only: values, paths, durations, and versions are deliberately excluded so the snapshot is stable across machines and releases.';

/** Every tool is read-only against the reference project; nothing executes. */
const CAPTURE_PARAMS: Record<string, Record<string, unknown>> = {
  py_environment: {},
  py_project_inspect: {},
  py_dependency_plan: { includeUnused: true },
  py_tdd_checkpoint: { changedPaths: ['src/ledger/totals.py', 'tests/test_other.py'] },
  py_completion_evidence: {
    syncExecuted: false,
    syncOk: false,
    testExecuted: false,
    testOk: false,
    stale: false,
    changedPaths: ['src/ledger/totals.py'],
  },
  py_test_select: { changedPaths: ['src/ledger/totals.py'] },
  py_test: { execute: false },
  py_failure_diagnose: { output: FAILURE_SAMPLE },
  py_sync: { mode: 'check', execute: false },
  py_validation_bundle: { execute: false },
};

export function loadRegisteredTools(): Map<string, ToolLike> {
  return loadRegistration().tools;
}

export interface RegisteredCommand {
  name: string;
  description: string;
}

/** Load the extension with a stub host, so the surface can be read without pi. */
export function loadRegistration(): {
  tools: Map<string, ToolLike>;
  commands: RegisteredCommand[];
} {
  const tools = new Map<string, ToolLike>();
  const commands: RegisteredCommand[] = [];
  register({
    registerTool: (tool: ToolLike) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: { description?: string }) => {
      commands.push({ name, description: options?.description ?? '' });
    },
  } as unknown as Parameters<typeof register>[0]);
  return { tools, commands };
}

function schemaType(schema: JsonSchema | undefined): string {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf
      .map((option) =>
        option.const !== undefined ? JSON.stringify(option.const) : schemaType(option),
      )
      .join(' | ');
  }
  if (schema.type === 'array') return `array<${schemaType(schema.items)}>`;
  return schema.type ?? 'unknown';
}

function schemaConstraints(schema: JsonSchema): string | undefined {
  const parts: string[] = [];
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    parts.push(`${schema.minimum ?? '-inf'}..${schema.maximum ?? 'inf'}`);
  }
  if (schema.maxItems !== undefined) parts.push(`maxItems ${schema.maxItems}`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function buildParameters(tool: ToolLike): Record<string, ParameterSurface> {
  const required = new Set(tool.parameters.required ?? []);
  const properties = tool.parameters.properties ?? {};
  return Object.fromEntries(
    Object.keys(properties)
      .sort()
      .map((key) => {
        const schema = properties[key];
        const constraints = schemaConstraints(schema);
        return [
          key,
          {
            type: schemaType(schema),
            required: required.has(key),
            ...(schema.description ? { description: schema.description } : {}),
            ...(constraints ? { constraints } : {}),
          } satisfies ParameterSurface,
        ];
      }),
  );
}

export interface CapturePreconditions {
  ok: boolean;
  reason?: string;
}

/** Capture needs a Python 3 interpreter (the scanner) and uv (for its version). */
export async function capturePreconditions(): Promise<CapturePreconditions> {
  if (!(await resolveInterpreter(process.cwd()))) {
    return { ok: false, reason: 'no Python 3 interpreter is available to run the scanner' };
  }
  const uv = await runCommand('uv', ['--version'], {
    cwd: process.cwd(),
    timeoutMs: 10000,
    maxBytes: 4096,
  });
  if (uv.code !== 0) {
    return {
      ok: false,
      reason: 'uv is not installed, so py_environment would report a different shape',
    };
  }
  return { ok: true };
}

export interface CaptureResult {
  envelope: ShapeNode;
  data: Map<string, ShapeNode>;
}

/**
 * Invoke every tool against the reference project and describe the shape of the
 * JSON the agent actually receives. Serializing first matters: the model reads
 * `JSON.stringify(details)`, where keys whose value is `undefined` disappear, so
 * the snapshot must reflect the serialized document rather than the raw object.
 */
export async function captureToolResults(): Promise<CaptureResult> {
  const fixture = await createFixtureProject();
  try {
    const tools = loadRegisteredTools();
    const details: unknown[] = [];
    const data = new Map<string, ShapeNode>();

    for (const [name, params] of Object.entries(CAPTURE_PARAMS)) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} is not registered`);
      const response = await tool.execute('capture', params, undefined, undefined, {
        cwd: fixture.root,
      });
      const serialized = JSON.parse(JSON.stringify(response.details ?? null)) as Record<
        string,
        unknown
      >;
      details.push(serialized);
      data.set(name, describeValue(serialized.data));
    }

    // Merging every tool result describes one envelope document: keys present in
    // some tools but not others become optional.
    return { envelope: describeSamples(details), data };
  } finally {
    await fixture.cleanup();
  }
}

export async function buildSnapshot(): Promise<ApiSurfaceSnapshot> {
  const tools = loadRegisteredTools();
  const snapshot: ApiSurfaceSnapshot = {
    generator: 'scripts/generate-api-surface.ts',
    note: SNAPSHOT_NOTE,
    tools: Object.fromEntries(
      [...tools.keys()]
        .sort()
        .map((name) => [
          name,
          { label: tools.get(name)!.label, parameters: buildParameters(tools.get(name)!) },
        ]),
    ),
  };

  if (!(await capturePreconditions()).ok) return snapshot;

  const capture = await captureToolResults();
  snapshot.capture = CAPTURE_PARAMS;
  snapshot.envelope = capture.envelope;
  for (const [name, shape] of capture.data) {
    const entry = snapshot.tools[name];
    if (entry) entry.data = shape;
  }
  return snapshot;
}

/** Collapse whitespace and bound the length so long samples stay readable in a table. */
function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ');
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** Nested bullet rendering: object fields become a readable tree, not one long line. */
function renderFields(node: ShapeNode, indent = 0): string[] {
  const pad = '  '.repeat(indent);
  if (node.kind !== 'object' || node.fields.length === 0) {
    return [`${pad}- ${renderShape(node)}`];
  }
  return node.fields.flatMap((field) => {
    const head = `${pad}- \`${field.key}\`${field.optional ? ' (optional)' : ''}: `;
    if (field.shape.kind === 'object') {
      if (field.shape.fields.length === 0) return [`${head}object`];
      return [`${head}object`, ...renderFields(field.shape, indent + 1)];
    }
    if (field.shape.kind === 'array' && field.shape.items.kind === 'object') {
      if (field.shape.items.fields.length === 0) return [`${head}array of object`];
      return [`${head}array of`, ...renderFields(field.shape.items, indent + 1)];
    }
    return [`${head}${renderShape(field.shape)}`];
  });
}

function renderParameterTable(parameters: Record<string, ParameterSurface>): string[] {
  const keys = Object.keys(parameters);
  if (keys.length === 0) return ['(파라미터 없음)'];
  const lines = ['| 파라미터 | 타입 | 필수 | 설명 |', '|---|---|---|---|'];
  for (const key of keys) {
    const parameter = parameters[key];
    const notes = [parameter.description, parameter.constraints]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .replace(/\|/g, '\\|');
    lines.push(
      `| \`${key}\` | \`${parameter.type}\` | ${parameter.required ? '예' : '아니오'} | ${notes || '—'} |`,
    );
  }
  return lines;
}

export interface RenderOptions {
  commands?: { name: string; description: string }[];
}

/**
 * Render the tool reference from the live registrations plus the committed
 * snapshot. Descriptions come from the code, so the prose cannot drift; the
 * return shapes come from the snapshot, so rendering needs no interpreter.
 */
export function renderToolsMarkdown(
  tools: Map<string, ToolLike>,
  snapshot: ApiSurfaceSnapshot | undefined,
  options: RenderOptions = {},
): string {
  const ordered = [...tools.keys()].sort();
  const lines: string[] = [
    '# 도구 레퍼런스 (Tool reference)',
    '',
    '> 이 문서는 생성된 파일입니다. 직접 편집하지 마세요.',
    '>',
    '> ```bash',
    '> npm run docs          # 이 문서와 docs/api-surface.json을 다시 생성',
    '> ```',
    '>',
    '> 출처: `extensions/`의 도구 등록(설명·파라미터)과 `docs/api-surface.json`(반환 형태 스냅샷).',
    '',
    '## 응답 규격 (Response envelope)',
    '',
    '모든 도구는 동일한 `PyToolResult` 규격을 반환합니다. 반환 형태는 구조만 기록하며 값·경로·버전·소요시간은 스냅샷에서 제외합니다.',
    '',
  ];

  if (snapshot?.envelope) {
    // `data` and `evidence` are tool-specific: merging every tool's payload here
    // would obscure the shared envelope instead of documenting it. They are
    // documented per tool below.
    const COLLAPSED = new Set(['data', 'evidence']);
    const envelope: ShapeNode =
      snapshot.envelope.kind === 'object'
        ? {
            kind: 'object',
            fields: snapshot.envelope.fields.map((field) =>
              COLLAPSED.has(field.key)
                ? field.key === 'data'
                  ? { ...field, shape: { kind: 'object' as const, fields: [] } }
                  : {
                      ...field,
                      shape: {
                        kind: 'array' as const,
                        items: { kind: 'object' as const, fields: [] },
                      },
                    }
                : field,
            ),
          }
        : snapshot.envelope;
    lines.push(...renderFields(envelope), '');
    lines.push(
      '`data`와 `evidence`의 내부 형태는 도구마다 다르며, 아래 각 도구 섹션에 기록되어 있습니다.',
      '',
    );
  } else {
    lines.push(
      '- `ok`: boolean — 도구가 유효한 진단을 만들었는지',
      '- `summary`: string — 한 줄 요약',
      '- `data` (optional): object — 도구별 상세',
      '- `evidence`: array of object — 에이전트가 근거로 인용할 항목',
      '- `warnings`, `errors`: array of object — `code`/`message`/`severity`/`path`/`line`',
      '- `suggestions`: array of object — `message`/`confidence`/`command`',
      '- `commands` (optional): array of object — `executable`/`args`/`cwd`/`risk`',
      '- `metadata`: object — `toolVersion`/`cwd`/`durationMs`/`truncated` 등',
      '',
      '> 반환 형태 스냅샷이 없습니다. python3와 uv가 있는 환경에서 `npm run docs`를 실행하면 채워집니다.',
      '',
    );
  }

  if (snapshot?.capture) {
    lines.push(
      '## 스냅샷 캡처 조건 (Capture conditions)',
      '',
      '반환 형태는 다음 파라미터로 참조 프로젝트(`scripts/api-docs/fixture.ts`)를 진단해 캡처했습니다. 모든 호출은 읽기 전용입니다.',
      '',
      '| 도구 | 파라미터 |',
      '|---|---|',
      ...Object.entries(snapshot.capture).map(
        ([name, params]) =>
          `| \`${name}\` | \`${truncate(JSON.stringify(params), 110).replace(/\|/g, '\\|')}\` |`,
      ),
      '',
    );
  }

  lines.push('## 도구 (Tools)', '');
  for (const name of ordered) {
    const tool = tools.get(name)!;
    const surface = snapshot?.tools[name];
    lines.push(`### \`${name}\``, '');
    lines.push(`${tool.description}`, '');
    if (tool.promptSnippet) lines.push(`- 시스템 프롬프트 한 줄: \`${tool.promptSnippet}\``);
    lines.push(`- 라벨: ${tool.label}`);
    const requiresExecute = Object.hasOwn(buildParameters(tool), 'execute');
    lines.push(
      `- 프로젝트 상태 변경: ${requiresExecute ? '`execute: true` 옵트인 필요' : '없음 (읽기 전용)'}`,
    );
    lines.push('');

    lines.push('**파라미터**', '');
    // Always render from the live schema: the code is the source of truth, and
    // reading parameters from the snapshot would let the document show a stale
    // schema without failing the check.
    lines.push(...renderParameterTable(buildParameters(tool)), '');

    const guidelines = tool.promptGuidelines ?? [];
    if (guidelines.length > 0) {
      lines.push('**프롬프트 가이드라인**', '');
      lines.push(...guidelines.map((guideline) => `- ${guideline}`), '');
    }

    if (surface?.data) {
      lines.push('**반환 `data` 형태**', '');
      lines.push(...renderFields(surface.data), '');
    } else if (snapshot?.envelope) {
      lines.push('**반환 `data` 형태**: 캡처되지 않음', '');
    }
  }

  const commands = options.commands ?? [];
  if (commands.length > 0) {
    lines.push('## 대화형 명령어 (Commands)', '');
    for (const command of commands) {
      lines.push(`- \`/${command.name}\` — ${command.description}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
