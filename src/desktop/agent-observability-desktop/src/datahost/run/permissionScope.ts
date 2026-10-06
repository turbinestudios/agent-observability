/**
 * What "Allow for this session" covers for one permission request.
 *
 * The runtime only remembers a session approval when it is told WHAT to
 * remember: reading files, changing files, these command names, this tool, this
 * web domain. Answering "for this session" without that is an approval of the
 * one request only, which is why the scope is derived here, from the request
 * itself, and travels with the answer.
 *
 * A scope is always narrower than "everything": there is one per kind of
 * action, and a request of a kind this file does not know has no scope, so the
 * only answers for it are once or deny.
 *
 * Pure, and imports nothing: the controller uses the same rules to decide
 * whether a request that is already waiting is covered by an approval the user
 * has just given.
 */
export type SessionScope =
  | { kind: 'read' }
  | { kind: 'write' }
  | { kind: 'memory' }
  | { kind: 'commands'; commandIdentifiers: string[] }
  | { kind: 'mcp'; serverName: string; toolName: string }
  | { kind: 'custom-tool'; toolName: string }
  | { kind: 'url'; domain: string };

/** The scope a session approval of this request would have, or `undefined` when it can only be approved once. */
export function scopeOf(request: Record<string, unknown>): SessionScope | undefined {
  switch (request.kind) {
    case 'read':
      return { kind: 'read' };
    case 'write':
      return { kind: 'write' };
    case 'memory':
      return { kind: 'memory' };
    case 'shell': {
      const commands = Array.isArray(request.commands) ? request.commands : [];
      const identifiers = commands
        .map((command) => (command as { identifier?: unknown } | null)?.identifier)
        .filter((identifier): identifier is string => typeof identifier === 'string' && identifier.length > 0);
      // A command line the runtime could not break into named commands cannot
      // be remembered by name.
      return identifiers.length > 0 && identifiers.length === commands.length
        ? { kind: 'commands', commandIdentifiers: [...new Set(identifiers)] }
        : undefined;
    }
    case 'mcp':
      return typeof request.serverName === 'string' && typeof request.toolName === 'string'
        ? { kind: 'mcp', serverName: request.serverName, toolName: request.toolName }
        : undefined;
    case 'custom-tool':
      return typeof request.toolName === 'string' ? { kind: 'custom-tool', toolName: request.toolName } : undefined;
    case 'url': {
      const domain = typeof request.url === 'string' ? domainOf(request.url) : undefined;
      return domain !== undefined ? { kind: 'url', domain } : undefined;
    }
    default:
      return undefined;
  }
}

/** Whether an approval the user gave for `granted` also answers a request whose scope is `wanted`. */
export function scopeCovers(granted: SessionScope, wanted: SessionScope): boolean {
  switch (granted.kind) {
    case 'read':
    case 'write':
    case 'memory':
      return wanted.kind === granted.kind;
    case 'commands':
      return (
        wanted.kind === 'commands' && wanted.commandIdentifiers.every((id) => granted.commandIdentifiers.includes(id))
      );
    case 'mcp':
      return wanted.kind === 'mcp' && wanted.serverName === granted.serverName && wanted.toolName === granted.toolName;
    case 'custom-tool':
      return wanted.kind === 'custom-tool' && wanted.toolName === granted.toolName;
    case 'url':
      return wanted.kind === 'url' && wanted.domain === granted.domain;
  }
}

/** The scope in the user's words, to finish "Allow … for this session". */
export function scopeLabel(scope: SessionScope): string {
  switch (scope.kind) {
    case 'read':
      return 'reading files';
    case 'write':
      return 'changing files';
    case 'memory':
      return 'saving memories';
    case 'commands':
      return scope.commandIdentifiers.length === 1
        ? `the command ${scope.commandIdentifiers[0]}`
        : `the commands ${scope.commandIdentifiers.join(', ')}`;
    case 'mcp':
      return `the tool ${scope.toolName} from ${scope.serverName}`;
    case 'custom-tool':
      return `the tool ${scope.toolName}`;
    case 'url':
      return `web addresses on ${scope.domain}`;
  }
}

function domainOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}
