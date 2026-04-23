import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { MULTIPLAYER_HERO_MOVE_SPEED, MULTIPLAYER_RUNTIME_CONFIG, MULTIPLAYER_SPAWN_LAYOUTS, MULTIPLAYER_TEST_LINEUP } from '../src/config/multiplayerShared.js';

const PORT = Number(process.env.BATTLE_SOCKET_PORT || 3001);
const ROOM_ID = MULTIPLAYER_RUNTIME_CONFIG.roomId;
const TICK_RATE = MULTIPLAYER_RUNTIME_CONFIG.simulationTickRate;
const SNAPSHOT_RATE = MULTIPLAYER_RUNTIME_CONFIG.snapshotRate;
const TRANSIENT_COMMAND_RETENTION_MS = Math.max(250, Math.ceil(1000 / SNAPSHOT_RATE) * 3);
const MAX_TICK_DELTA_SECONDS = 0.25;

const FULL_TURN = Math.PI * 2;
const ROTATION_LERP_SPEED = 14;

function createAuthoritativeLineup() {
  return ['blue', 'red'].flatMap((team) => {
    const teamLineup = MULTIPLAYER_TEST_LINEUP.filter((item) => item.team === team);
    const teamSpawnLayouts = MULTIPLAYER_SPAWN_LAYOUTS[team];

    return teamLineup
      .map((item, slotIndex) => {
        const spawnPoint = teamSpawnLayouts[slotIndex];
        if (!spawnPoint) {
          return null;
        }

        return {
          id: `${team}_${slotIndex}`,
          heroId: item.heroId,
          playerName: item.playerName,
          team,
          skin: item.skin,
          x: spawnPoint[0],
          y: spawnPoint[1],
          z: spawnPoint[2],
          rotation: team === 'blue' ? 0 : Math.PI,
          moveSpeed: MULTIPLAYER_HERO_MOVE_SPEED[item.heroId] ?? 3,
        };
      })
      .filter(Boolean);
  });
}

const lineup = createAuthoritativeLineup();

function getShortestAngleDelta(current, target) {
  return ((target - current + Math.PI) % FULL_TURN + FULL_TURN) % FULL_TURN - Math.PI;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value, fallback = 0) {
  const nextValue = Number(value);
  return Number.isFinite(nextValue) ? nextValue : fallback;
}

function sanitizeTransientDuration(durationMs) {
  return clampNumber(toFiniteNumber(durationMs, TRANSIENT_COMMAND_RETENTION_MS), 0, 5000);
}

function sanitizeMoveTarget(target) {
  if (!target || typeof target !== 'object') {
    return null;
  }

  return {
    x: clampNumber(toFiniteNumber(target.x), -125, 125),
    y: 0,
    z: clampNumber(toFiniteNumber(target.z), -19.6, 19.6),
  };
}

function serializeVector3(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function createChampionState(seed) {
  return {
    id: seed.id,
    heroId: seed.heroId,
    skin: seed.skin,
    playerName: seed.playerName,
    team: seed.team,
    position: { x: seed.x, y: seed.y, z: seed.z },
    rotation: seed.rotation,
    hp: 1000,
    maxHp: 1000,
    mp: 600,
    maxMp: 600,
    level: 9,
    kills: 0,
    deaths: 0,
    assists: 0,
    isDead: false,
    respawnTimer: 0,
    animationState: 'idle',
    animationClipRequest: null,
    isMe: false,
    moveTarget: null,
    inputMode: 'idle',
    movementLockedUntil: 0,
    idleStartedAt: Date.now(),
    lastVoiceRequest: null,
    animationClipRequestExpiresAt: 0,
    lastVoiceRequestExpiresAt: 0,
    moveSpeed: seed.moveSpeed,
  };
}

function createRoomState() {
  return {
    id: ROOM_ID,
    createdAt: Date.now(),
    sequence: 0,
    gameTimer: 0,
    blueKills: 0,
    redKills: 0,
    champions: lineup.map(createChampionState),
    towers: [],
    nexuses: [],
    healthRelics: [],
    activeEmotes: [],
    players: [],
  };
}

const room = createRoomState();

function getPlayerBySocketId(socketId) {
  return room.players.find((player) => player.socketId === socketId) ?? null;
}

function getAvailableChampion() {
  const occupied = new Set(room.players.map((player) => player.championId).filter(Boolean));
  return room.champions.find((champion) => !occupied.has(champion.id)) ?? null;
}

function buildAssignment(socketId, playerName) {
  const champion = getAvailableChampion();
  return {
    socketId,
    playerName,
    championId: champion?.id ?? null,
    team: champion?.team ?? null,
    isSpectator: !champion,
  };
}

function applyOwnership() {
  const ownershipMap = new Map(room.players.map((player) => [player.championId, player.socketId]));
  room.champions.forEach((champion) => {
    champion.isMe = false;
    if (!ownershipMap.has(champion.id)) {
      return;
    }
  });
}

function getChampionById(championId) {
  return room.champions.find((champion) => champion.id === championId) ?? null;
}

function emitPlayers(io) {
  io.to(room.id).emit('room:players', room.players);
}

function clearExpiredTransientChampionState(now) {
  room.champions.forEach((champion) => {
    if (champion.animationClipRequest && champion.animationClipRequestExpiresAt <= now) {
      champion.animationClipRequest = null;
      champion.animationClipRequestExpiresAt = 0;
    }

    if (champion.lastVoiceRequest && champion.lastVoiceRequestExpiresAt <= now) {
      champion.lastVoiceRequest = null;
      champion.lastVoiceRequestExpiresAt = 0;
    }
  });
}

function buildChampionSnapshot(champion, now) {
  const animationClipRequest = champion.animationClipRequest
    && champion.animationClipRequestExpiresAt > now
    ? { ...champion.animationClipRequest }
    : null;
  const lastVoiceRequest = champion.lastVoiceRequest
    && champion.lastVoiceRequestExpiresAt > now
    ? { ...champion.lastVoiceRequest }
    : null;

  return {
    id: champion.id,
    heroId: champion.heroId,
    skin: champion.skin,
    playerName: champion.playerName,
    team: champion.team,
    position: serializeVector3(champion.position),
    rotation: champion.rotation,
    hp: champion.hp,
    maxHp: champion.maxHp,
    mp: champion.mp,
    maxMp: champion.maxMp,
    level: champion.level,
    kills: champion.kills,
    deaths: champion.deaths,
    assists: champion.assists,
    isDead: champion.isDead,
    respawnTimer: champion.respawnTimer,
    animationState: champion.animationState,
    moveTarget: champion.moveTarget ? serializeVector3(champion.moveTarget) : null,
    inputMode: champion.inputMode,
    movementLockedUntil: champion.movementLockedUntil,
    idleStartedAt: champion.idleStartedAt,
    animationClipRequest,
    lastVoiceRequest,
    isMe: false,
  };
}

function emitSnapshot(io, { volatile = false } = {}) {
  const now = Date.now();
  clearExpiredTransientChampionState(now);
  room.sequence += 1;
  const snapshot = {
    sequence: room.sequence,
    timestamp: now,
    gameTimer: room.gameTimer,
    blueKills: room.blueKills,
    redKills: room.redKills,
    champions: room.champions.map((champion) => buildChampionSnapshot(champion, now)),
    activeEmotes: room.activeEmotes.map((item) => ({ ...item })),
    createdAt: room.createdAt,
    expiresAt: now + 1000,
  };

  if (volatile) {
    io.to(room.id).volatile.emit('game:snapshot', snapshot);
    return;
  }

  io.to(room.id).emit('game:snapshot', snapshot);
}

function tick(deltaSeconds) {
  room.gameTimer += deltaSeconds;
  const now = Date.now();
  room.activeEmotes = room.activeEmotes.filter((item) => item.expiresAt > now);
  clearExpiredTransientChampionState(now);

  room.champions.forEach((champion) => {
    if (champion.movementLockedUntil > now) {
      champion.moveTarget = null;
      champion.inputMode = 'idle';
      return;
    }

    if (!champion.moveTarget) {
      if (champion.animationState === 'run') {
        champion.animationState = 'idle';
        champion.idleStartedAt = now;
      }
      return;
    }

    const dx = champion.moveTarget.x - champion.position.x;
    const dz = champion.moveTarget.z - champion.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= 0.08) {
      champion.position = { ...champion.moveTarget };
      champion.moveTarget = null;
      champion.inputMode = 'idle';
      champion.animationState = 'idle';
      champion.idleStartedAt = now;
      return;
    }

    const step = Math.min(distance, champion.moveSpeed * deltaSeconds);
    const dirX = dx / distance;
    const dirZ = dz / distance;
    champion.position.x = clampNumber(champion.position.x + dirX * step, -125, 125);
    champion.position.z = clampNumber(champion.position.z + dirZ * step, -19.6, 19.6);
    const desiredRotation = Math.atan2(dirX, dirZ);
    const rotationDelta = getShortestAngleDelta(champion.rotation, desiredRotation);
    champion.rotation += rotationDelta * Math.min(1, deltaSeconds * ROTATION_LERP_SPEED);
    champion.animationState = 'run';
    champion.inputMode = 'mouse';
  });
}

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

io.on('connection', (socket) => {
  socket.on('room:join', (payload = {}) => {
    socket.join(room.id);
    const assignment = buildAssignment(socket.id, payload.playerName || `玩家-${room.players.length + 1}`);
    room.players = [...room.players.filter((player) => player.socketId !== socket.id), assignment];
    applyOwnership();
    socket.emit('room:joined', {
      roomId: room.id,
      socketId: socket.id,
      assignment,
    });
    emitPlayers(io);
    emitSnapshot(io, { volatile: false });
  });

  socket.on('champion:move', (payload) => {
    if (!payload || typeof payload.championId !== 'string') {
      return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (!player || player.championId !== payload?.championId) {
      return;
    }
    const champion = getChampionById(payload.championId);
    if (!champion) {
      return;
    }
    champion.moveTarget = sanitizeMoveTarget(payload.target);
    champion.inputMode = payload.inputMode || 'mouse';
    if (!champion.moveTarget) {
      champion.animationState = 'idle';
      champion.idleStartedAt = Date.now();
    }
  });

  socket.on('champion:stop', (payload) => {
    if (!payload || typeof payload.championId !== 'string') {
      return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (!player || player.championId !== payload?.championId) {
      return;
    }
    const champion = getChampionById(payload.championId);
    if (!champion) {
      return;
    }
    champion.moveTarget = null;
    champion.inputMode = 'idle';
    champion.animationState = 'idle';
    champion.idleStartedAt = Date.now();
  });

  socket.on('champion:animate', (payload) => {
    if (
      !payload
      || typeof payload.championId !== 'string'
      || !payload.request
      || typeof payload.request.clipName !== 'string'
    ) {
      return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (!player || player.championId !== payload?.championId) {
      return;
    }
    const champion = getChampionById(payload.championId);
    if (!champion) {
      return;
    }
    const now = Date.now();
    const request = {
      ...payload.request,
      nonce: toFiniteNumber(payload.request.nonce, now + Math.random()),
      durationMs: sanitizeTransientDuration(payload.request.durationMs),
    };
    champion.animationClipRequest = request;
    champion.animationClipRequestExpiresAt = now + TRANSIENT_COMMAND_RETENTION_MS;
    champion.animationState = request.fallbackState || 'idle';
    if (request.lockMovement) {
      champion.moveTarget = null;
      champion.inputMode = 'idle';
      champion.movementLockedUntil = now + Math.max(0, request.durationMs || 0);
    }
  });

  socket.on('champion:emote', (payload) => {
    if (!payload || typeof payload.championId !== 'string' || typeof payload.emoteId !== 'string') {
      return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (!player || player.championId !== payload?.championId) {
      return;
    }
    const champion = getChampionById(payload.championId);
    if (!champion) {
      return;
    }
    const now = Date.now();
    room.activeEmotes.push({
      id: `${payload.championId}_${payload.emoteId}_${now}`,
      championId: payload.championId,
      playerName: champion.playerName,
      emoteId: payload.emoteId,
      createdAt: now,
      expiresAt: now + Math.max(300, payload.durationMs || 1800),
      isMe: false,
    });
  });

  socket.on('champion:voice', (payload) => {
    if (
      !payload
      || typeof payload.championId !== 'string'
      || !payload.request
      || typeof payload.request.slot !== 'string'
    ) {
      return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (!player || player.championId !== payload?.championId) {
      return;
    }
    const champion = getChampionById(payload.championId);
    if (!champion) {
      return;
    }
    const now = Date.now();
    champion.lastVoiceRequest = {
      ...payload.request,
      nonce: toFiniteNumber(payload.request.nonce, now + Math.random()),
    };
    champion.lastVoiceRequestExpiresAt = now + TRANSIENT_COMMAND_RETENTION_MS;
  });

  /* 客户端长时间未收到 volatile 快照时，可请求一次可靠快照进行恢复（仅回复请求方） */
  socket.on('room:requestSnapshot', () => {
    const now = Date.now();
    clearExpiredTransientChampionState(now);
    room.sequence += 1;
    const snapshot = {
      sequence: room.sequence,
      timestamp: now,
      gameTimer: room.gameTimer,
      blueKills: room.blueKills,
      redKills: room.redKills,
      champions: room.champions.map((champion) => buildChampionSnapshot(champion, now)),
      activeEmotes: room.activeEmotes.map((item) => ({ ...item })),
      createdAt: room.createdAt,
      expiresAt: now + 1000,
    };
    socket.emit('game:snapshot', snapshot);
  });

  socket.on('disconnect', () => {
    room.players = room.players.filter((player) => player.socketId !== socket.id);
    emitPlayers(io);
    emitSnapshot(io, { volatile: false });
  });
});

/*
 * 合并 tick 与 snapshot 为单一定时器，避免两个独立 setInterval 长时间运行后漂移导致不同步。
 * 以 TICK_RATE 为主驱动频率，通过计数器按 SNAPSHOT_RATE 间隔发送快照。
 */
let lastTickAt = Date.now();
const ticksPerSnapshot = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));
let tickCounter = 0;
setInterval(() => {
  const now = Date.now();
  const deltaSeconds = Math.min(MAX_TICK_DELTA_SECONDS, (now - lastTickAt) / 1000);
  lastTickAt = now;
  tick(deltaSeconds);

  tickCounter += 1;
  if (tickCounter >= ticksPerSnapshot) {
    tickCounter = 0;
    emitSnapshot(io, { volatile: true });
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`[battle-3d-demo] socket server listening on http://localhost:${PORT}`);
});
