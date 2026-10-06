import type {
  RunEventChange,
  RunInputRequest,
  RunItem,
  RunPermissionRequest,
  RunStatus,
  RunTranscript,
} from '../../../../shared/runTypes';

/**
 * How one hosted session's view state follows the datahost's `run.event`
 * pushes. Pure, and imports nothing from the data-host client, so it tests
 * under the node-only vitest setup.
 *
 * Assistant and reasoning items arrive as WHOLE host-rendered HTML each time,
 * so applying an event is an upsert by id: a dropped event can delay the
 * text, never corrupt it.
 */
export interface RunViewState {
  status: RunStatus;
  items: RunItem[];
  permission?: RunPermissionRequest;
  input?: RunInputRequest;
  usage?: { inputTokens: number; outputTokens: number; nanoAiu?: number };
}

export const EMPTY_RUN_VIEW: RunViewState = { status: 'starting', items: [] };

/** The state a remount starts from: whatever the datahost has for the session. */
export function fromTranscript(transcript: RunTranscript): RunViewState {
  return {
    status: transcript.info.status,
    items: transcript.items,
    ...(transcript.pendingPermission !== undefined ? { permission: transcript.pendingPermission } : {}),
    ...(transcript.pendingInput !== undefined ? { input: transcript.pendingInput } : {}),
  };
}

export function applyRunEvent(state: RunViewState, change: RunEventChange): RunViewState {
  switch (change.type) {
    case 'status':
      return state.status === change.status ? state : { ...state, status: change.status };
    case 'item': {
      const at = state.items.findIndex((item) => item.id === change.item.id);
      if (at === -1) {
        return { ...state, items: [...state.items, change.item] };
      }
      const items = state.items.slice();
      items[at] = change.item;
      return { ...state, items };
    }
    case 'permission':
      return { ...state, permission: change.request };
    case 'permission-cleared':
      return state.permission?.requestId === change.requestId ? omit(state, 'permission') : state;
    case 'input':
      return { ...state, input: change.request };
    case 'input-cleared':
      return state.input?.requestId === change.requestId ? omit(state, 'input') : state;
    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: change.inputTokens,
          outputTokens: change.outputTokens,
          ...(change.nanoAiu !== undefined ? { nanoAiu: change.nanoAiu } : {}),
        },
      };
  }
}

function omit(state: RunViewState, key: 'permission' | 'input'): RunViewState {
  const next = { ...state };
  delete next[key];
  return next;
}
