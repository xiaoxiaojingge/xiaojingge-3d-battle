import { io } from 'socket.io-client';
import { MULTIPLAYER_RUNTIME_CONFIG } from '../src/config/multiplayerShared.js';

const SERVER_URL = process.env.BATTLE_SOCKET_SERVER_URL || `http://localhost:${process.env.BATTLE_SOCKET_PORT || 3001}`;
const CLIENT_COUNT = Math.max(1, Number(process.env.BATTLE_LOADTEST_CLIENTS || 20));
const DURATION_MS = Math.max(5000, Number(process.env.BATTLE_LOADTEST_DURATION_MS || 30000));
const MOVE_INTERVAL_MS = Math.max(300, Number(process.env.BATTLE_LOADTEST_MOVE_INTERVAL_MS || 1200));
const EMOTE_INTERVAL_MS = Math.max(800, Number(process.env.BATTLE_LOADTEST_EMOTE_INTERVAL_MS || 4000));
const STAGGER_MS = Math.max(0, Number(process.env.BATTLE_LOADTEST_STAGGER_MS || 120));
const EMOTES = ['thumbsUp', 'laugh', 'angry', 'question'];

const stats = {
  connected: 0,
  disconnected: 0,
  joined: 0,
  snapshots: 0,
  snapshotErrors: 0,
  moveCommands: 0,
  emoteCommands: 0,
  serverErrors: 0,
};

const clients = [];
const startedAt = Date.now();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function createRandomTarget() {
  return {
    x: randomBetween(-120, 120),
    y: 0,
    z: randomBetween(-18, 18),
  };
}

function createClient(index) {
  const socket = io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
  });

  const state = {
    socket,
    assignment: null,
    moveTimer: null,
    emoteTimer: null,
  };

  socket.on('connect', () => {
    stats.connected += 1;
    socket.emit('room:join', { playerName: `压测-${index + 1}` });
  });

  socket.on('disconnect', () => {
    stats.disconnected += 1;
    if (state.moveTimer) clearInterval(state.moveTimer);
    if (state.emoteTimer) clearInterval(state.emoteTimer);
  });

  socket.on('room:joined', ({ assignment }) => {
    state.assignment = assignment;
    stats.joined += 1;

    if (!assignment?.championId || assignment.isSpectator) {
      return;
    }

    state.moveTimer = setInterval(() => {
      socket.emit('champion:move', {
        championId: assignment.championId,
        target: createRandomTarget(),
        inputMode: 'mouse',
      });
      stats.moveCommands += 1;
    }, MOVE_INTERVAL_MS);

    state.emoteTimer = setInterval(() => {
      socket.emit('champion:emote', {
        championId: assignment.championId,
        emoteId: EMOTES[Math.floor(Math.random() * EMOTES.length)],
        durationMs: 1600,
      });
      stats.emoteCommands += 1;
    }, EMOTE_INTERVAL_MS);
  });

  socket.on('game:snapshot', () => {
    stats.snapshots += 1;
  });

  socket.on('server:error', () => {
    stats.serverErrors += 1;
  });

  socket.on('connect_error', () => {
    stats.snapshotErrors += 1;
  });

  return state;
}

for (let i = 0; i < CLIENT_COUNT; i += 1) {
  const client = createClient(i);
  clients.push(client);
  setTimeout(() => client.socket.connect(), i * STAGGER_MS);
}

setTimeout(() => {
  const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
  const spectatorCount = clients.filter((client) => client.assignment?.isSpectator).length;

  console.log('[battle-3d-demo] socket load test summary');
  console.log(JSON.stringify({
    serverUrl: SERVER_URL,
    roomId: MULTIPLAYER_RUNTIME_CONFIG.roomId,
    clients: CLIENT_COUNT,
    durationMs: DURATION_MS,
    elapsedSeconds,
    connected: stats.connected,
    disconnected: stats.disconnected,
    joined: stats.joined,
    spectators: spectatorCount,
    snapshots: stats.snapshots,
    snapshotsPerSecond: Number((stats.snapshots / elapsedSeconds).toFixed(2)),
    moveCommands: stats.moveCommands,
    emoteCommands: stats.emoteCommands,
    serverErrors: stats.serverErrors,
    snapshotErrors: stats.snapshotErrors,
  }, null, 2));

  clients.forEach((client) => {
    if (client.moveTimer) clearInterval(client.moveTimer);
    if (client.emoteTimer) clearInterval(client.emoteTimer);
    client.socket.disconnect();
  });

  setTimeout(() => process.exit(0), 200);
}, DURATION_MS);
