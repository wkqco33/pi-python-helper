/**
 * Value-to-shape description used by the API-surface snapshot and the generated
 * tool reference.
 *
 * Only structure is recorded, never values, so the snapshot stays stable across
 * machines, package versions, and timestamps while still failing when a tool
 * starts or stops returning a field.
 */

export type PrimitiveName = 'string' | 'number' | 'boolean' | 'null' | 'unknown';

export type ShapeNode =
  | { kind: 'primitive'; name: PrimitiveName }
  | { kind: 'array'; items: ShapeNode }
  | { kind: 'object'; fields: { key: string; optional: boolean; shape: ShapeNode }[] }
  | { kind: 'union'; options: ShapeNode[] };

/** Recursion stops here; deeper payloads collapse to `unknown`. */
const MAX_DEPTH = 5;

type Coarse = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown';

function coarse(value: unknown): Coarse {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

function unknownNode(): ShapeNode {
  return { kind: 'primitive', name: 'unknown' };
}

function describeObject(samples: Record<string, unknown>[], depth: number): ShapeNode {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))].sort();
  const fields = keys.map((key) => {
    const present = samples
      .filter((sample) => Object.hasOwn(sample, key))
      .map((sample) => sample[key]);
    return {
      key,
      optional: present.length < samples.length,
      shape: describeSamples(present, depth + 1),
    };
  });
  return { kind: 'object', fields };
}

/**
 * Describe the shape of one or more observed values. Passing every sample of a
 * field together is what makes `optional` and unions meaningful: a field that is
 * a string in one tool result and absent in another becomes `name?: string`.
 */
export function describeSamples(samples: unknown[], depth = 0): ShapeNode {
  if (samples.length === 0) return unknownNode();

  const kinds = new Set(samples.map(coarse));
  if (kinds.size === 1) {
    const [only] = [...kinds];
    if (only === 'object' || only === 'array') {
      if (depth >= MAX_DEPTH) return unknownNode();
      if (only === 'object') return describeObject(samples as Record<string, unknown>[], depth);
      const items = (samples as unknown[][]).flat();
      return { kind: 'array', items: describeSamples(items, depth + 1) };
    }
    return { kind: 'primitive', name: only };
  }

  const options = [...kinds].sort().map((kind) =>
    describeSamples(
      samples.filter((sample) => coarse(sample) === kind),
      depth,
    ),
  );
  return { kind: 'union', options };
}

export function describeValue(value: unknown): ShapeNode {
  return describeSamples(value === undefined ? [] : [value]);
}

function dedupe(options: ShapeNode[]): ShapeNode[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = JSON.stringify(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Single-line rendering, used for inline shapes and union members. */
export function renderShape(node: ShapeNode): string {
  switch (node.kind) {
    case 'primitive':
      return node.name === 'unknown' ? '…' : node.name;
    case 'array':
      return `array<${renderShape(node.items)}>`;
    case 'union':
      return dedupe(node.options).map(renderShape).join(' | ');
    case 'object':
      if (node.fields.length === 0) return '{}';
      return `{ ${node.fields
        .map((field) => `${field.key}${field.optional ? '?' : ''}: ${renderShape(field.shape)}`)
        .join(', ')} }`;
  }
}
