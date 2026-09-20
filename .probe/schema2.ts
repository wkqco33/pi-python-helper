import register from '../extensions/index.ts';
const tools = new Map<string, any>();
register({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: () => {} } as any);
console.log('=== py_completion_evidence ===');
console.log(JSON.stringify(tools.get('py_completion_evidence').parameters, null, 1));
console.log('=== py_tdd_checkpoint (required key?) ===');
console.log(JSON.stringify(tools.get('py_tdd_checkpoint').parameters));
console.log('=== py_failure_diagnose ===');
console.log(JSON.stringify(tools.get('py_failure_diagnose').parameters));
