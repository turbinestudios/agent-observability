import * as path from 'node:path';
import { COPILOT_PAYLOAD_POINTER_PREFIX } from '../chat/backends/copilotCliArgs';
import type { CliEvent } from './events';
import { cliSessionCwd } from './mapper';

/**
 * The app's own Copilot helper runs (AI Helper, Deep Retrospective,
 * Improvement Plans on the Copilot backend) go through the same CLI and so
 * leave sessions in the same store. They are the app talking, not the
 * developer working, and must never appear in a list, a count or a shard.
 *
 * Two rules. From 1.18.0 every helper run starts in a dedicated directory,
 * which makes recognition exact and content-free. Runs from before that
 * started in the home directory; they are matched by a deliberately narrow
 * shape so a real session that happened to start at home is kept.
 */
export interface HelperRunContext {
  helperCwd: string;
  homeDir: string;
  platform?: NodeJS.Platform;
}

export function isHelperRun(
  events: readonly CliEvent[],
  workspace: Readonly<Record<string, string>>,
  context: HelperRunContext,
): boolean {
  const cwd = cliSessionCwd(workspace, events);
  if (cwd === undefined) {
    return false;
  }
  if (samePath(cwd, context.helperCwd, context.platform)) {
    return true;
  }
  if (!samePath(cwd, context.homeDir, context.platform)) {
    return false;
  }
  const prompts = events.filter((e) => e.type === 'user.message');
  if (prompts.length !== 1) {
    return false;
  }
  const tools = events.filter((e) => e.type === 'tool.execution_start');
  if (tools.length === 0) {
    // A tool-less one-shot at home: the helper's small-prompt transport.
    return events.filter((e) => e.type === 'assistant.message').length <= 2;
  }
  const prompt = typeof prompts[0].data.content === 'string' ? prompts[0].data.content : '';
  return tools.length === 1 && tools[0].data.toolName === 'view' && prompt.startsWith(COPILOT_PAYLOAD_POINTER_PREFIX);
}

function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const n = path.normalize(p).replace(/[\\/]+$/, '');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}
