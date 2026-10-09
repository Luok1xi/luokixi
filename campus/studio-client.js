// Functional adapter only. Opus owns page layout, visual identity and interactions.
import { createHubClient } from './hub-client.js';

export function createStudioClient(hub = createHubClient()) {
  const id = value => encodeURIComponent(value);
  return {
    codexChat: () => hub.request('studio/codex/chat'),
    tellCodex: (body, requestKey = crypto.randomUUID()) => hub.request('studio/codex/messages', { body, requestKey }),
    capabilities: () => hub.request('studio/capabilities'),
    activity: () => hub.request('studio/activity'),
    inspect: () => hub.request('studio/inspect', {}),
    rooms: () => hub.request('studio/rooms'),
    createRoom: ({ title, brief = '', contextFiles = [] }) => hub.request('studio/rooms', { title, brief, contextFiles }),
    room: key => hub.request(`studio/rooms/${id(key)}`),
    run: key => hub.request(`studio/runs/${id(key)}`),
    start: (room, { prompt, mode = 'discuss', seats = ['beikuang', 'codex'], rounds = mode === 'work' ? 6 : 3, requestKey = crypto.randomUUID() }) =>
      hub.request(`studio/rooms/${id(room)}/runs`, { prompt, mode, seats, rounds, requestKey }),
    stop: run => hub.request(`studio/runs/${id(run)}/stop`, {}),
    approve: (run, hash, acknowledgeUnrunTests = false) => hub.request(`studio/runs/${id(run)}/approve`, { hash, acknowledgeUnrunTests }),
  };
}
