import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { detectPythonEnvironment } from '../src/environment/discovery.ts';
import { registerDependencyTools } from './tools/dependencies.ts';
import { registerEnvironmentTools } from './tools/environment.ts';
import { registerTestingTools } from './tools/testing.ts';
import { registerValidationTools } from './tools/validation.ts';

export default function (pi: ExtensionAPI): void {
  registerEnvironmentTools(pi);
  registerDependencyTools(pi);
  registerTestingTools(pi);
  registerValidationTools(pi);

  pi.registerCommand('py-status', {
    description: 'Show a concise Python interpreter and uv project status',
    handler: async (_args, ctx) => {
      const environment = await detectPythonEnvironment(ctx.cwd);
      const python = environment.python;
      const ok = Boolean(environment.interpreter);
      ctx.ui.notify(
        `Python ${python?.version ?? 'unavailable'} · ${python?.inVirtualEnvironment ? 'virtual environment' : 'system interpreter'} · uv ${
          environment.uv.available ? (environment.uv.version ?? 'ready') : 'missing'
        } · ${environment.projectRoot ?? 'no project root'}`,
        ok ? 'info' : 'warning',
      );
    },
  });
}
