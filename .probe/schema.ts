import register from '../extensions/index.ts';
const tools = new Map<string, any>();
register({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: () => {} } as any);
for (const name of ['py_environment', 'py_test', 'py_sync', 'py_project_inspect']) {
  console.log('===', name, '===');
  console.log(JSON.stringify(tools.get(name).parameters, null, 1));
}
