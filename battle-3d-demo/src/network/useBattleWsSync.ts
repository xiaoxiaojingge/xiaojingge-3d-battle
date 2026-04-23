/**
 * 战斗 Socket.IO 同步 Hook。
 * 职责：
 *   1. 管理 Socket.IO 连接生命周期（随组件挂载/卸载自动连接/断开）
 *   2. 监听服务端 combatSnapshot 事件，将战斗快照映射到 useGameStore
 *   3. 监听 spellCastAccepted / spellCastRejected / spellCastStarted 等事件
 *   4. 监听 room:joined 事件完成入房流程
 *
 * 已从原生 WebSocket（battleWsClient）迁移到 Socket.IO（socketClient），
 * 使用 netty-socketio 后端的原生事件模型，消除额外的消息包装开销。
 *
 * 用法：在 BattleCanvas 或 App 组件顶层调用 useBattleWsSync()。
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import {
  connectToBattleSocket,
  disconnectBattleSocket,
  getSocketClient,
} from './socketClient';
import { GAME_CONFIG } from '../config/gameConfig';
import { useGameStore } from '../store/useGameStore';
import { getHeroActionConfig, HEROES } from '../config/heroConfig';
import type {
  AreaCreatedEvent,
  AreaExpiredEvent,
  ChampionState,
  CombatImpactVfxState,
  DamageAppliedEvent,
  DeathOccurredEvent,
  DisplacementResolvedEvent,
  FloatingCombatTextState,
  HealAppliedEvent,
  HeroActionSlot,
  PlayerSessionAssignment,
  ProjectilePresentationState,
  ProjectileDestroyedEvent,
  ProjectileSpawnedEvent,
  AreaPresentationState,
  ShieldChangedEvent,
  StatusEffectViewState,
  StatusAppliedEvent,
  StatusRemovedEvent,
  AnimationClipRequest,
  SkillRuntimeState,
  SpellSlot,
  VoicePlaybackSlot,
  VoicePlaybackRequest,
} from '../types/game';

/** 服务端 combatSnapshot 中的英雄字段（来自 BattleSimulationService 快照格式） */
interface ServerChampionSnapshot {
  id: string;
  heroId: string;
  skin?: string;
  playerName: string;
  team: string;
  position: { x: number; y: number; z: number };
  rotation: number;
  moveTarget?: { x: number; y: number; z: number } | null;
  moveSpeed?: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  level?: number;
  isDead?: boolean;
  animationState?: string;
  shield?: number;
  flowValue?: number;
  activeCastInstanceId?: string | null;
  activeCastPhase?: string;
  skillStates?: Record<string, unknown>;
  statusEffects?: unknown[];
}

/** 服务端 combatSnapshot 投射物快照 */
interface ServerProjectileSnapshot {
  projectileId: string;
  castInstanceId?: string;
  ownerId: string;
  skillId: string;
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  speed: number;
  radius?: number;
  blockable?: boolean;
}

/** 服务端 combatSnapshot 区域体快照 */
interface ServerAreaSnapshot {
  areaId: string;
  castInstanceId?: string;
  ownerId: string;
  skillId: string;
  areaType?: string;
  position: { x: number; y: number; z: number };
  radius: number;
  rotationY?: number;
  length?: number;
  width?: number;
  height?: number;
  expiresAt?: number;
}

/** 服务端 combatSnapshot 状态效果快照 */
interface ServerStatusSnapshot {
  statusInstanceId: string;
  statusId: string;
  sourceEntityId: string;
  targetEntityId: string;
  stacks: number;
  durationMs?: number;
  expiresAt?: number;
}

/** 服务端 combatSnapshot 玩家会话快照 */
interface ServerPlayerSnapshot {
  sessionId: string;
  playerName: string;
  championId: string | null;
  team?: 'blue' | 'red' | null;
  spectator?: boolean;
  isSpectator?: boolean;
}

/** 服务端 combatSnapshot 整体结构 */
interface ServerCombatSnapshot {
  sequence: number;
  tickFrame?: number;
  frame?: number;
  timestamp?: number;
  serverTime?: number;
  roomId: string;
  gameTimer: number;
  champions?: ServerChampionSnapshot[];
  projectiles?: ServerProjectileSnapshot[];
  areas?: ServerAreaSnapshot[];
  statuses?: ServerStatusSnapshot[];
  players?: ServerPlayerSnapshot[];
  /** 兼容旧字段名（服务端可能使用 entities 而非 champions） */
  entities?: ServerChampionSnapshot[];
}

interface CastPresentationContext {
  targetEntityId?: string;
  targetPoint?: { x: number; y: number; z: number } | null;
}

const LATENCY_SMOOTHING_FACTOR = 0.2;

function getSnapshotServerTime(snapshot: ServerCombatSnapshot): number {
  const candidate = snapshot.serverTime ?? snapshot.timestamp;
  return typeof candidate === 'number' ? candidate : Date.now();
}


function smoothLatencyMs(previousLatencyMs: number | null | undefined, nextLatencyMs: number): number {
  if (previousLatencyMs == null) {
    return nextLatencyMs;
  }
  return Math.round(previousLatencyMs + (nextLatencyMs - previousLatencyMs) * LATENCY_SMOOTHING_FACTOR);
}

function toAnimationClipRequest(raw: unknown): AnimationClipRequest | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.clipName !== 'string') {
    return null;
  }

  return {
    clipName: value.clipName,
    loop: typeof value.loop === 'boolean' ? value.loop : undefined,
    playbackRate: typeof value.playbackRate === 'number' ? value.playbackRate : undefined,
    reset: typeof value.reset === 'boolean' ? value.reset : undefined,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined,
    lockMovement: typeof value.lockMovement === 'boolean' ? value.lockMovement : undefined,
    fallbackState: typeof value.fallbackState === 'string' ? value.fallbackState as AnimationClipRequest['fallbackState'] : undefined,
    actionSlot: typeof value.actionSlot === 'string' ? value.actionSlot as HeroActionSlot : undefined,
    nonce: typeof value.nonce === 'number' ? value.nonce : undefined,
  };
}

function toVoicePlaybackRequest(raw: unknown): VoicePlaybackRequest | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.slot !== 'string' || typeof value.nonce !== 'number') {
    return null;
  }

  return {
    nonce: value.nonce,
    slot: value.slot as VoicePlaybackSlot,
    customVoiceId: typeof value.customVoiceId === 'string' ? value.customVoiceId : undefined,
    voiceUrl: typeof value.voiceUrl === 'string' ? value.voiceUrl : undefined,
    volume: typeof value.volume === 'number' ? value.volume : undefined,
  };
}

function mapServerPlayersToLocal(players: ServerPlayerSnapshot[] | undefined): PlayerSessionAssignment[] {
  if (!players || players.length === 0) {
    return [];
  }
  return players.map((player) => ({
    socketId: player.sessionId,
    playerName: player.playerName,
    championId: player.championId,
    team: player.team ?? null,
    isSpectator: player.isSpectator ?? player.spectator ?? false,
  }));
}

function mapServerSkillStatesToLocal(
  skillStates: Record<string, unknown> | undefined,
  previousSkillStates: ChampionState['skillStates'] | undefined,
): ChampionState['skillStates'] {
  const nextStates = { ...(previousSkillStates ?? {}) } as ChampionState['skillStates'];
  if (!skillStates) {
    return nextStates;
  }
  Object.entries(skillStates).forEach(([slot, rawState]) => {
    if (!rawState || typeof rawState !== 'object') {
      return;
    }
    const state = rawState as Record<string, unknown>;
    const normalizedSlot = slot as SpellSlot;
    const previous = nextStates[normalizedSlot];
    nextStates[normalizedSlot] = {
      slot: normalizedSlot,
      skillId: (state.skillId as string) ?? previous?.skillId ?? normalizedSlot,
      name: (state.name as string) ?? previous?.name ?? normalizedSlot.toUpperCase(),
      level: typeof state.level === 'number' ? state.level : (previous?.level ?? 0),
      maxCooldownMs: typeof state.maxCooldownMs === 'number' ? state.maxCooldownMs : (previous?.maxCooldownMs ?? 0),
      remainingCooldownMs: typeof state.remainingCooldownMs === 'number' ? state.remainingCooldownMs : (previous?.remainingCooldownMs ?? 0),
      isReady: typeof state.isReady === 'boolean' ? state.isReady : (previous?.isReady ?? true),
      insufficientResource: typeof state.insufficientResource === 'boolean' ? state.insufficientResource : (previous?.insufficientResource ?? false),
      isSecondPhase: typeof state.isSecondPhase === 'boolean' ? state.isSecondPhase : (previous?.isSecondPhase ?? false),
      isCasting: typeof state.isCasting === 'boolean' ? state.isCasting : (previous?.isCasting ?? false),
    } satisfies SkillRuntimeState;
  });
  return nextStates;
}

function attachStatusesToChampions(
  champions: ChampionState[],
  statuses: StatusEffectViewState[],
): ChampionState[] {
  const statusMap = new Map<string, StatusEffectViewState[]>();
  for (const status of statuses) {
    if (!statusMap.has(status.targetEntityId)) {
      statusMap.set(status.targetEntityId, []);
    }
    statusMap.get(status.targetEntityId)!.push(status);
  }
  return champions.map((champion) => ({
    ...champion,
    statusEffects: statusMap.get(champion.id) ?? [],
  }));
}

function toSerializedVector3(vector: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function toEventVector3(raw: unknown): { x: number; y: number; z: number } | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.z !== 'number') {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

function resolveCastTargetPoint(
  caster: ChampionState,
  targetPoint: { x: number; y: number; z: number } | null | undefined,
  targetEntityId?: string,
): { x: number; y: number; z: number } | null {
  if (targetPoint) {
    return targetPoint;
  }
  if (!targetEntityId) {
    return null;
  }
  const target = useGameStore.getState().champions.find((champion) => champion.id === targetEntityId);
  return target ? toSerializedVector3(target.position) : null;
}

function resolveCastRotation(
  caster: ChampionState,
  targetPoint: { x: number; y: number; z: number } | null,
): number {
  if (!targetPoint) {
    return caster.rotation;
  }
  const dx = targetPoint.x - caster.position.x;
  const dz = targetPoint.z - caster.position.z;
  if (Math.abs(dx) <= 0.0001 && Math.abs(dz) <= 0.0001) {
    return caster.rotation;
  }
  return Math.atan2(dx, dz);
}

function resolveEventPosition(
  position: { x: number; y: number; z: number } | undefined,
  targetEntityId?: string,
): { x: number; y: number; z: number } {
  if (position) {
    return position;
  }
  const champion = targetEntityId
    ? useGameStore.getState().champions.find((item) => item.id === targetEntityId)
    : null;
  if (champion) {
    return toSerializedVector3(champion.position);
  }
  return { x: 0, y: 0, z: 0 };
}

function shouldConsumeOrderedEvent(
  payload: Record<string, unknown>,
  lastProcessedEventSequenceRef: MutableRefObject<number>,
): boolean {
  const sequence = typeof payload.sequence === 'number' ? payload.sequence : null;
  if (sequence == null) {
    return true;
  }
  if (sequence <= lastProcessedEventSequenceRef.current) {
    return false;
  }
  lastProcessedEventSequenceRef.current = sequence;
  return true;
}

function pushCombatImpactVfx(vfx: Omit<CombatImpactVfxState, 'id'>): void {
  useGameStore.getState().pushCombatImpactVfx({
    ...vfx,
    id: `impact_${Date.now()}_${Math.random()}`,
  });
}

function pushFloatingCombatText(text: Omit<FloatingCombatTextState, 'id'>): void {
  useGameStore.getState().pushFloatingCombatText({
    ...text,
    id: `text_${Date.now()}_${Math.random()}`,
  });
}

/**
 * 将服务端投射物快照映射为前端 ProjectilePresentationState 格式。
 */
function mapServerProjectileToLocal(proj: ServerProjectileSnapshot): ProjectilePresentationState {
  return {
    projectileId: proj.projectileId,
    castInstanceId: proj.castInstanceId ?? '',
    ownerId: proj.ownerId,
    skillId: proj.skillId,
    position: { x: proj.position.x, y: proj.position.y, z: proj.position.z },
    direction: { x: proj.direction.x, y: proj.direction.y, z: proj.direction.z },
    speed: proj.speed,
    radius: proj.radius,
    blockable: proj.blockable,
  };
}

/**
 * 将服务端区域体快照映射为前端 AreaPresentationState 格式。
 */
function mapServerAreaToLocal(area: ServerAreaSnapshot): AreaPresentationState {
  return {
    areaId: area.areaId,
    castInstanceId: area.castInstanceId ?? '',
    ownerId: area.ownerId,
    skillId: area.skillId,
    areaType: area.areaType,
    position: { x: area.position.x, y: area.position.y, z: area.position.z },
    radius: area.radius,
    rotationY: area.rotationY,
    length: area.length,
    width: area.width,
    height: area.height,
    expiresAt: area.expiresAt,
  };
}

/**
 * 将服务端状态效果快照映射为前端 StatusEffectViewState 格式。
 */
function mapServerStatusToLocal(status: ServerStatusSnapshot): StatusEffectViewState {
  return {
    statusInstanceId: status.statusInstanceId,
    statusId: status.statusId,
    sourceEntityId: status.sourceEntityId,
    targetEntityId: status.targetEntityId,
    stacks: status.stacks,
    durationMs: status.durationMs,
    expiresAt: status.expiresAt,
  };
}

/** 默认待机延迟（毫秒），当英雄资源配置中未指定时使用。 */
const DEFAULT_STANDBY_DELAY_MS = 1400;

/** 查询英雄的 standby 延迟。 */
function getStandbyDelay(heroId: string): number {
  const hero = HEROES.find((h) => h.heroId === heroId);
  return hero?.asset?.animations.standbyDelayMs ?? DEFAULT_STANDBY_DELAY_MS;
}

/**
 * 将服务端英雄快照映射为前端 ChampionState 格式。
 *
 * ═══ 设计原则（联机模式）═══
 * 1. **位置**：直接使用服务端权威位置，不做中间混合。
 *    所有渲染平滑由 Champion.tsx 的 useFrame lerp 独立承担。
 * 2. **animationState**：在此函数中一次性决定最终值（含 idle→standby 轮转），
 *    tickMovement 联机模式下为 no-op，不再写入 champions。
 * 3. **idleStartedAt**：使用客户端本地时间域，仅在 animationState 变为 idle 时
 *    用 Date.now() 记录，避免前后端时钟偏差导致 standby 判定乒乓。
 */
function mapServerChampionToLocal(
  serverChampion: ServerChampionSnapshot,
  controlledChampionId: string | null,
  previousChampion: ChampionState | undefined,
): ChampionState {
  const now = Date.now();
  const isMe = serverChampion.id === controlledChampionId;

  /* ── 位置：直接使用服务端权威位置 ──
   * 距离极近（≤0.001²）时复用旧引用避免无意义对象创建。
   * Champion.tsx 的 useFrame lerp 负责所有视觉平滑。
   * 使用 distanceToSquared 避免每次调用 sqrt。 */
  const sx = serverChampion.position.x;
  const sy = serverChampion.position.y;
  const sz = serverChampion.position.z;
  let position: THREE.Vector3;
  if (previousChampion) {
    const pp = previousChampion.position;
    const dx = pp.x - sx, dy = pp.y - sy, dz = pp.z - sz;
    position = (dx * dx + dy * dy + dz * dz) <= 1e-6
      ? pp
      : new THREE.Vector3(sx, sy, sz);
  } else {
    position = new THREE.Vector3(sx, sy, sz);
  }

  /* ── moveTarget ── */
  const serverHasMoveTarget = !!serverChampion.moveTarget;
  const nextMovementLockedUntil = ((serverChampion as unknown as Record<string, unknown>).movementLockedUntil as number | undefined) ?? 0;

  /* 操作者本地运动保护：仅当服务端也认为该英雄正在移动时保留本地 moveTarget */
  const shouldPreserveLocalMotion = !!previousChampion
    && isMe
    && !!previousChampion.moveTarget
    && serverHasMoveTarget
    && previousChampion.movementLockedUntil <= now
    && nextMovementLockedUntil <= now;

  /* moveTarget：当服务端 moveTarget 与前一帧相近时复用旧引用 */
  let serverMoveTarget: THREE.Vector3 | null = null;
  if (serverChampion.moveTarget) {
    const mx = serverChampion.moveTarget.x;
    const my = serverChampion.moveTarget.y ?? 0;
    const mz = serverChampion.moveTarget.z;
    const prevMt = previousChampion?.moveTarget;
    if (prevMt) {
      const dmx = prevMt.x - mx, dmy = prevMt.y - my, dmz = prevMt.z - mz;
      serverMoveTarget = (dmx * dmx + dmy * dmy + dmz * dmz) <= 1e-6 ? prevMt : new THREE.Vector3(mx, my, mz);
    } else {
      serverMoveTarget = new THREE.Vector3(mx, my, mz);
    }
  }
  const moveTarget = shouldPreserveLocalMotion
    ? (previousChampion?.moveTarget ?? serverMoveTarget)
    : serverMoveTarget;

  /* ── 朝向 ── */
  const rotation = serverChampion.rotation ?? previousChampion?.rotation ?? 0;

  /* ── isDead ── */
  const isDead = serverChampion.isDead ?? (serverChampion as unknown as Record<string, unknown>).dead as boolean ?? false;

  /* ── animationState（一次性决定最终值）──
   * 优先级：death > 服务端权威 > 操作者本地保护 > idle→standby 轮转 */
  const resolvedAnimationState: ChampionState['animationState'] = (() => {
    if (isDead) return 'death' as const;

    const serverAnimState = (serverChampion.animationState ?? 'idle') as ChampionState['animationState'];

    /* 一致性兜底：服务端 moveTarget 为空但 animationState 残留 run → 纠正为 idle */
    if (!serverHasMoveTarget && serverAnimState === 'run') {
      // fall through 到 idle 分支处理
    } else if (isMe && previousChampion) {
      /* 操作者正向保护：本地正在移动 + 服务端延迟回传 idle → 保持 run */
      if (!!previousChampion.moveTarget && serverAnimState === 'idle' && previousChampion.animationState === 'run') {
        return 'run' as const;
      }
      /* 操作者反向保护：本地已停 + 服务端延迟回传 run → 保持 idle/standby */
      if (!previousChampion.moveTarget && serverAnimState === 'run'
          && (previousChampion.animationState === 'idle' || previousChampion.animationState === 'standby')) {
        return previousChampion.animationState;
      }
      /* 非 idle 状态（run/attack/cast 等）直接信任服务端 */
      if (serverAnimState !== 'idle') {
        return serverAnimState;
      }
      /* serverAnimState === 'idle'：fall through 到下面的 idle→standby 轮转判定 */
    } else {
      /* 非操作者：非 idle 状态直接信任服务端 */
      if (serverAnimState !== 'idle') {
        return serverAnimState;
      }
      /* serverAnimState === 'idle'：fall through 到下面的 idle→standby 轮转判定 */
    }

    /* 到这里 animationState 应该是 idle，做 idle→standby 轮转判定 */
    const prevIdleStartedAt = previousChampion?.idleStartedAt ?? now;
    /* 仅当前一帧也是 idle 或 standby 时才延用之前的 idleStartedAt，
     * 否则视为刚进入 idle 状态，重置计时。 */
    const prevWasIdle = previousChampion
      && (previousChampion.animationState === 'idle' || previousChampion.animationState === 'standby');
    const idleStartedAt = prevWasIdle ? prevIdleStartedAt : now;
    const standbyDelay = getStandbyDelay(serverChampion.heroId);

    if (now - idleStartedAt >= standbyDelay) {
      return 'standby' as const;
    }
    return 'idle' as const;
  })();

  /* ── idleStartedAt（客户端时间域）── */
  const idleStartedAt: number = (() => {
    if (!previousChampion) return now;
    const prevWasIdle = previousChampion.animationState === 'idle' || previousChampion.animationState === 'standby';
    const nowIsIdle = resolvedAnimationState === 'idle' || resolvedAnimationState === 'standby';
    /* 从非 idle 切换到 idle 时重置；持续 idle/standby 时延用 */
    if (nowIsIdle && prevWasIdle) return previousChampion.idleStartedAt;
    if (nowIsIdle && !prevWasIdle) return now;
    /* 非 idle 状态，保留上次值以备后续切回 */
    return previousChampion.idleStartedAt;
  })();

  return {
    id: serverChampion.id,
    heroId: serverChampion.heroId,
    skin: serverChampion.skin ?? previousChampion?.skin,
    playerName: `${serverChampion.playerName.replace(/\(我\)$/, '')}${isMe ? '(我)' : ''}`,
    team: serverChampion.team as 'blue' | 'red',
    position,
    rotation,
    hp: serverChampion.hp,
    maxHp: serverChampion.maxHp,
    mp: serverChampion.mp,
    maxMp: serverChampion.maxMp,
    level: serverChampion.level ?? 1,
    kills: 0,
    deaths: 0,
    assists: 0,
    isDead,
    respawnTimer: 0,
    animationState: resolvedAnimationState,
    animationClipRequest: previousChampion?.animationClipRequest ?? null,
    isMe,
    moveTarget,
    inputMode: shouldPreserveLocalMotion
      ? previousChampion?.inputMode ?? 'mouse'
      : moveTarget ? 'mouse' : 'idle',
    movementLockedUntil: nextMovementLockedUntil,
    idleStartedAt,
    lastVoiceRequest: previousChampion?.lastVoiceRequest ?? null,
    shield: serverChampion.shield ?? 0,
    flowValue: serverChampion.flowValue ?? 0,
    skillStates: mapServerSkillStatesToLocal(serverChampion.skillStates, previousChampion?.skillStates),
    statusEffects: previousChampion?.statusEffects ?? [],
    activeCastInstanceId: serverChampion.activeCastInstanceId ?? null,
    activeCastPhase: (serverChampion.activeCastPhase ?? 'idle') as ChampionState['activeCastPhase'],
  };
}

/**
 * 战斗 WebSocket 同步 Hook。
 * @param enabled 是否启用（可用 gameConfig 控制）
 * @param playerName 玩家名称
 */
export function useBattleWsSync(enabled: boolean, playerName?: string): void {
  /** 缓存受控英雄 ID */
  const controlledChampionIdRef = useRef<string | null>(null);
  /** 缓存技能实例的施法目标上下文，供 resolve 阶段表现复用。 */
  const castPresentationContextRef = useRef<Map<string, CastPresentationContext>>(new Map());
  /** 缓存最近一次收到的快照序号。 */
  const lastReceivedSnapshotSequenceRef = useRef(0);
  /** 缓存最近已消费的快照序号。 */
  const lastProcessedSnapshotSequenceRef = useRef(0);
  /** 缓存最近已消费的权威事件序号，避免重复与乱序回放。 */
  const lastProcessedEventSequenceRef = useRef(0);
  /** 正式战斗快照缓冲队列。 */
  const snapshotQueueRef = useRef<ServerCombatSnapshot[]>([]);

  useEffect(() => {
    if (!enabled) {
      useGameStore.getState().setMultiplayerConnectionStatus('idle');
      return;
    }

    controlledChampionIdRef.current = null;
    lastReceivedSnapshotSequenceRef.current = 0;
    lastProcessedSnapshotSequenceRef.current = 0;
    lastProcessedEventSequenceRef.current = 0;
    snapshotQueueRef.current = [];
    castPresentationContextRef.current.clear();

    const updateDiagnostics = (patch: Partial<ReturnType<typeof useGameStore.getState>['multiplayerSession']['diagnostics']>) => {
      useGameStore.setState((state) => ({
        multiplayerSession: {
          ...state.multiplayerSession,
          diagnostics: {
            ...state.multiplayerSession.diagnostics,
            ...patch,
          },
        },
      }));
    };

    const applyBufferedSnapshot = (snapshot: ServerCombatSnapshot) => {
      if (typeof snapshot.sequence === 'number' && snapshot.sequence <= lastProcessedSnapshotSequenceRef.current) {
        return;
      }

      const store = useGameStore.getState();
      const controlledId = controlledChampionIdRef.current;
      const serverChampions = snapshot.champions ?? snapshot.entities ?? [];
      const previousChampionMap = new Map(
        store.champions.map((champion) => [champion.id, champion]),
      );

      const nextChampions = serverChampions.map((serverChampion) =>
        mapServerChampionToLocal(serverChampion, controlledId, previousChampionMap.get(serverChampion.id)),
      );
      const nextProjectiles = (snapshot.projectiles ?? []).map(mapServerProjectileToLocal);
      const nextAreas = (snapshot.areas ?? []).map(mapServerAreaToLocal);
      const nextStatuses = (snapshot.statuses ?? []).map(mapServerStatusToLocal);
      const nextPlayers = mapServerPlayersToLocal(snapshot.players);
      const nextSequence = typeof snapshot.sequence === 'number' ? snapshot.sequence : lastProcessedSnapshotSequenceRef.current;
      const serverTime = getSnapshotServerTime(snapshot);
      const receivedAt = Date.now();
      const rawLatencyMs = Math.max(0, receivedAt - serverTime);
      const nextLatencyMs = smoothLatencyMs(store.multiplayerSession.diagnostics.snapshotLatencyMs, rawLatencyMs);

      lastProcessedSnapshotSequenceRef.current = nextSequence;

      useGameStore.setState({
        gameTimer: snapshot.gameTimer ?? store.gameTimer,
        champions: attachStatusesToChampions(nextChampions, nextStatuses),
        projectiles: nextProjectiles,
        areas: nextAreas,
        combatStatuses: nextStatuses,
        multiplayerSession: {
          ...store.multiplayerSession,
          players: nextPlayers.length > 0 ? nextPlayers : store.multiplayerSession.players,
          diagnostics: {
            ...store.multiplayerSession.diagnostics,
            lastAppliedSequence: nextSequence,
            bufferedSnapshotCount: snapshotQueueRef.current.length,
            lastSnapshotServerTime: serverTime,
            lastSnapshotReceivedAt: receivedAt,
            snapshotLatencyMs: nextLatencyMs,
          },
        },
      });
    };

    useGameStore.getState().setMultiplayerConnectionStatus('connecting');

    /* 获取 Socket.IO 客户端实例 */
    const socket = getSocketClient();

    /* ========== Socket.IO 生命周期事件 ========== */

    const handleConnect = () => {
      /* connect 事件表示 WebSocket 通道已建立，但尚未完成入房握手，
       * 此时应显示 connecting 状态。入房成功后 room:joined 回调再切为 connected。 */
      useGameStore.getState().setMultiplayerConnectionStatus('connecting');
      console.log('[BattleWsSync] WebSocket 已连接，等待入房...');
    };

    const handleDisconnect = (reason: string) => {
      /* 区分主动断开和意外断线 */
      const isIntentional = reason === 'io client disconnect';
      if (!isIntentional) {
        useGameStore.getState().setMultiplayerConnectionStatus('disconnected', '召唤师，与战场的连接中断了，正在尝试重新连接...');
      } else {
        useGameStore.getState().setMultiplayerConnectionStatus('disconnected', '已离开战场');
      }
      console.log('[BattleWsSync] 连接断开:', reason);
    };

    const handleConnectError = (err: Error) => {
      useGameStore.getState().setMultiplayerConnectionStatus('error', '无法连接到战场服务器，请检查网络');
      console.warn('[BattleWsSync] 连接异常:', err.message);
    };

    /* 重连事件：Socket.IO 自动重连成功后触发。
     * 关键：必须重置所有序号 ref 和快照队列，因为服务端重启后序号从 0 开始，
     * 否则旧的大序号会导致新快照全部被当作乱序丢弃（droppedSnapshotCount 持续增加）。 */
    const handleReconnect = (attempt: number) => {
      console.log(`[BattleWsSync] 重连成功 (第${attempt}次尝试)，重置快照序号`);
      lastReceivedSnapshotSequenceRef.current = 0;
      lastProcessedSnapshotSequenceRef.current = 0;
      lastProcessedEventSequenceRef.current = 0;
      snapshotQueueRef.current = [];
    };
    const handleReconnectAttempt = (attempt: number) => {
      useGameStore.getState().setMultiplayerConnectionStatus('disconnected', `正在重新连接战场 (第${attempt}次尝试)...`);
    };
    const handleReconnectFailed = () => {
      useGameStore.getState().setMultiplayerConnectionStatus('error', '重连失败，请刷新页面重新进入战场');
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.io.on('reconnect', handleReconnect);
    socket.io.on('reconnect_attempt', handleReconnectAttempt);
    socket.io.on('reconnect_failed', handleReconnectFailed);

    /* 入房成功：重置序号 ref 确保新房间快照不会被旧序号过滤 */
    const handleJoined = (payload: Record<string, unknown>) => {
      const championId = payload.championId as string | undefined;
      const sessionId = payload.sessionId as string | undefined;
      const roomId = payload.roomId as string | undefined;
      if (championId) {
        /* 重置所有序号和快照队列（重连入房或首次入房） */
        lastReceivedSnapshotSequenceRef.current = 0;
        lastProcessedSnapshotSequenceRef.current = 0;
        lastProcessedEventSequenceRef.current = 0;
        snapshotQueueRef.current = [];
        controlledChampionIdRef.current = championId;
        useGameStore.getState().setMultiplayerAssignment(
          {
            socketId: sessionId ?? '',
            championId,
            team: ((payload.team as string | undefined) ?? null) as 'blue' | 'red' | null,
            playerName: (payload.playerName as string) ?? playerName ?? 'Player',
            isSpectator: (payload.spectator as boolean) ?? false,
          },
          sessionId ?? '',
          roomId ?? '',
        );
        useGameStore.getState().setMultiplayerConnectionStatus('connected');
        console.log(`[BattleWsSync] 入房成功: championId=${championId}`);
      }
    };
    socket.on('room:joined', handleJoined);

    /* 战斗快照：消费英雄、投射物、区域体和状态效果数据 */
    const handleSnapshot = (payload: Record<string, unknown>) => {
      const snapshot = payload as unknown as ServerCombatSnapshot;
      const sequence = typeof snapshot.sequence === 'number' ? snapshot.sequence : 0;
      const serverTime = getSnapshotServerTime(snapshot);
      const now = Date.now();
      const diagnostics = useGameStore.getState().multiplayerSession.diagnostics;
      const nextLatencyMs = smoothLatencyMs(diagnostics.snapshotLatencyMs, Math.max(0, now - serverTime));

      if (sequence > 0 && sequence <= lastReceivedSnapshotSequenceRef.current) {
        updateDiagnostics({
          lastSnapshotReceivedAt: now,
          lastSnapshotServerTime: serverTime,
          snapshotLatencyMs: nextLatencyMs,
          droppedSnapshotCount: diagnostics.droppedSnapshotCount + 1,
        });
        return;
      }

      if (sequence > 0) {
        lastReceivedSnapshotSequenceRef.current = sequence;
      }

      if (!snapshot || (!(snapshot.champions ?? snapshot.entities) && !snapshot.players)) {
        return;
      }

      const queue = snapshotQueueRef.current;
      queue.push(snapshot);

      let droppedByOverflow = 0;
      if (queue.length > GAME_CONFIG.multiplayer.maxBufferedSnapshots) {
        droppedByOverflow = queue.length - GAME_CONFIG.multiplayer.maxBufferedSnapshots;
        queue.splice(0, droppedByOverflow);
      }

      const mappedPlayers = mapServerPlayersToLocal(snapshot.players);
      if (mappedPlayers.length > 0) {
        useGameStore.getState().setMultiplayerPlayers(mappedPlayers);
      }

      updateDiagnostics({
        lastReceivedSequence: Math.max(sequence, diagnostics.lastReceivedSequence),
        lastSnapshotReceivedAt: now,
        lastSnapshotServerTime: serverTime,
        snapshotLatencyMs: nextLatencyMs,
        bufferedSnapshotCount: queue.length,
        droppedSnapshotCount: diagnostics.droppedSnapshotCount + droppedByOverflow,
      });
    };
    socket.on('combatSnapshot', handleSnapshot);

    /* ── 快照消费：使用 requestAnimationFrame 与渲染帧同步 ──
     * 替代 setInterval 以消除定时器精度抖动（±4ms+），
     * 保证快照消费和 Champion.tsx 的外推 lerp 在同一渲染帧内执行，
     * 避免"外推半帧后被快照重置"的微顿感。 */
    let flushRafId = 0;
    const flushSnapshotQueue = () => {
      const queue = snapshotQueueRef.current;
      if (queue.length === 0) {
        updateDiagnostics({ bufferedSnapshotCount: 0 });
        flushRafId = requestAnimationFrame(flushSnapshotQueue);
        return;
      }

      const now = Date.now();
      const renderDelayMs = GAME_CONFIG.multiplayer.renderDelayMs;

      let applied = false;
      let shouldForceCatchUp = queue.length >= Math.max(2, GAME_CONFIG.multiplayer.maxBufferedSnapshots - 1);
      while (queue.length > 1 && (now - getSnapshotServerTime(queue[0]) >= renderDelayMs || shouldForceCatchUp)) {
        const nextSnapshot = queue.shift();
        if (!nextSnapshot) {
          break;
        }
        applyBufferedSnapshot(nextSnapshot);
        applied = true;
        shouldForceCatchUp = queue.length >= Math.max(2, GAME_CONFIG.multiplayer.maxBufferedSnapshots - 1);
      }

      if (!applied && queue.length === 1 && now - getSnapshotServerTime(queue[0]) >= renderDelayMs) {
        const nextSnapshot = queue.shift();
        if (nextSnapshot) {
          applyBufferedSnapshot(nextSnapshot);
        }
      }

      updateDiagnostics({ bufferedSnapshotCount: queue.length });
      flushRafId = requestAnimationFrame(flushSnapshotQueue);
    };
    flushRafId = requestAnimationFrame(flushSnapshotQueue);

    /* 施法被接受：服务端确认施法合法，可用于客户端预测确认 */
    const handleAccepted = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const requestId = payload.requestId as string | undefined;
      const castInstanceId = payload.castInstanceId as string | undefined;
      if (requestId) {
        useGameStore.getState().acceptLocalSpellPrediction(requestId, castInstanceId ?? null);
      }
      console.log('[BattleWsSync] 施法已接受:', payload.castInstanceId, payload.skillId);
    };
    socket.on('spellCastAccepted', handleAccepted);

    /**
     * 施法被拒绝：回滚客户端预测。
     * 清除本地预播放的施法动画，使英雄恢复到正常状态。
     */
    const handleRejected = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      console.warn('[BattleWsSync] 施法被拒绝:', payload.reasonCode, payload.reasonMessage);
      const requestId = payload.requestId as string | undefined;
      const casterId = payload.casterId as string | undefined;
      const prediction = requestId
        ? useGameStore.getState().findLocalSpellPredictionByRequestId(requestId)
        : null;
      const rollbackCasterId = prediction?.casterId ?? casterId;
      if (rollbackCasterId) {
        /* 回滚：清除预测的施法动画并恢复 idle */
        useGameStore.getState().clearChampionAnimationClip(rollbackCasterId);
        useGameStore.getState().setChampionAnimationState(rollbackCasterId, 'idle');
      }
      if (requestId) {
        useGameStore.getState().clearLocalSpellPredictionByRequestId(requestId);
      }
      /* 如果是受控英雄且有瞄准快照，则恢复瞄准态供玩家重试 */
      if (prediction?.aimSnapshot && rollbackCasterId === controlledChampionIdRef.current) {
        useGameStore.getState().enterSpellAim(prediction.aimSnapshot);
      }
    };
    socket.on('spellCastRejected', handleRejected);

    /**
     * 施法开始：服务端通知某个英雄开始施法。
     * 在此触发前端施法动画和语音，使所有客户端都能看到施法表现。
     */
    const handleStarted = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const castInstanceId = payload.castInstanceId as string | undefined;
      const casterId = payload.casterId as string;
      const slot = (payload.slot as string) ?? '';
      const skillId = (payload.skillId as string) ?? '';
      const targetEntityId = payload.targetEntityId as string | undefined;
      const targetPoint = toEventVector3(payload.targetPoint);

      if (castInstanceId) {
        castPresentationContextRef.current.set(castInstanceId, {
          targetEntityId,
          targetPoint,
        });
      }

      /* 将本地预测标记为 started */
      if (castInstanceId) {
        useGameStore.getState().markLocalSpellPredictionStarted(castInstanceId);
      }

      /* 判断是否为本机预测过的施法，避免重复播放动画和语音 */
      const localPrediction = castInstanceId
        ? useGameStore.getState().findLocalSpellPredictionByCastInstanceId(castInstanceId)
        : null;
      const shouldSkipLocalReplay = !!localPrediction && casterId === controlledChampionIdRef.current;

      console.log('[BattleWsSync] 施法开始:', payload.castInstanceId, skillId, payload.stage);

      /* 触发施法动画（传入 casterId 以便从英雄配置获取动画参数） */
      if (!shouldSkipLocalReplay) {
        const animRequest = buildCastAnimationRequest(slot, skillId, casterId);
        if (animRequest && casterId) {
          useGameStore.getState().playChampionAnimationClip(casterId, animRequest);
        }
      }

      /* 触发施法语音 */
      if (!shouldSkipLocalReplay && casterId) {
        const voiceSlot = mapSlotToVoiceSlot(slot);
        if (voiceSlot) {
          useGameStore.getState().setChampionVoiceRequest(casterId, {
            slot: voiceSlot,
            nonce: Date.now() + Math.random(),
          });
        }
      }
    };
    socket.on('spellCastStarted', handleStarted);

    /**
     * 技能阶段切换：服务端通知技能从 windup->resolve->finished。
     * resolve 阶段可触发命中特效，finished 阶段可清理状态。
     */
    const handleStageChanged = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const castInstanceId = payload.castInstanceId as string | undefined;
      const nextStage = payload.nextStage as string;
      const casterId = payload.casterId as string;
      const slot = (payload.slot as string) ?? '';
      const skillId = (payload.skillId as string) ?? '';
      const stageTargetEntityId = payload.targetEntityId as string | undefined;
      const stageTargetPoint = toEventVector3(payload.targetPoint);
      const castPresentationContext = castInstanceId
        ? castPresentationContextRef.current.get(castInstanceId)
        : null;
      const localPrediction = castInstanceId
        ? useGameStore.getState().findLocalSpellPredictionByCastInstanceId(castInstanceId)
        : null;
      console.log('[BattleWsSync] 技能阶段切换:', payload.castInstanceId, payload.previousStage, '->', nextStage);

      /* resolve 阶段：触发效果表现（伤害数字、命中特效等） */
      if (nextStage === 'resolve') {
        const caster = useGameStore.getState().champions.find((champion) => champion.id === casterId);
        if (caster) {
          const now = Date.now();
          const casterPos = toSerializedVector3(caster.position);
          const resolvedTargetEntityId = stageTargetEntityId ?? castPresentationContext?.targetEntityId;
          const resolvedTargetPoint = resolveCastTargetPoint(
            caster,
            stageTargetPoint ?? castPresentationContext?.targetPoint,
            resolvedTargetEntityId,
          );
          const resolvedRotation = resolveCastRotation(caster, resolvedTargetPoint);

          /* ===== 亚索专属 VFX 分支 ===== */
          const isYasuoQ3 = skillId === 'yasuo_q3' || skillId === 'yasuo_q_steel_tempest_q3';
          const isYasuoW = skillId === 'yasuo_w_wind_wall' || skillId === 'yasuo_w';
          const isYasuoE = skillId === 'yasuo_e_sweeping_blade' || skillId === 'yasuo_e';
          const isYasuoR = skillId === 'yasuo_r_last_breath' || skillId === 'yasuo_r';

          if (isYasuoQ3) {
            /* 亚索 Q3：龙卷风凝聚特效 + 斩击光弧 */
            pushCombatImpactVfx({
              kind: 'tornado_cast',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 600,
            });
            pushCombatImpactVfx({
              kind: 'slash_arc',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 320,
            });
          } else if (isYasuoW) {
            /* 亚索 W：风墙展开特效 */
            pushCombatImpactVfx({
              kind: 'wind_wall_expand',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 450,
            });
          } else if (isYasuoE) {
            /* 亚索 E：冲刺残影特效 + 冲刺爆发 */
            pushCombatImpactVfx({
              kind: 'dash_trail',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 350,
            });
            pushCombatImpactVfx({
              kind: 'dash_burst',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 260,
            });
          } else if (isYasuoR) {
            /* 亚索 R：终极冲击波 + 终极爆发 */
            pushCombatImpactVfx({
              kind: 'ult_impact',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 700,
            });
            pushCombatImpactVfx({
              kind: 'ultimate_burst',
              position: casterPos,
              casterId,
              skillId,
              rotation: caster.rotation,
              createdAt: now,
              expiresAt: now + 520,
            });
          } else if (skillId === 'lux_q_light_binding') {
            pushCombatImpactVfx({
              kind: 'lux_snare',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 320,
            });
          } else if (skillId === 'lux_w_prismatic_barrier') {
            pushCombatImpactVfx({
              kind: 'lux_barrier',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 420,
            });
          } else if (skillId === 'lux_e_lucent_singularity' && resolvedTargetPoint) {
            pushCombatImpactVfx({
              kind: 'lux_zone',
              position: resolvedTargetPoint,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 850,
            });
          } else if (skillId === 'lux_r_final_spark') {
            pushCombatImpactVfx({
              kind: 'lux_beam',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 420,
            });
          } else if (skillId === 'annie_w_incinerate') {
            pushCombatImpactVfx({
              kind: 'annie_cone',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 260,
            });
          } else if (skillId === 'annie_r_summon_tibbers' && resolvedTargetPoint) {
            pushCombatImpactVfx({
              kind: 'annie_burst',
              position: resolvedTargetPoint,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 520,
            });
          } else if (skillId === 'ashe_w_volley') {
            pushCombatImpactVfx({
              kind: 'ashe_volley',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + 320,
            });
          } else if (skillId === 'jhin_w_deadly_flourish' || skillId === 'jhin_r_curtain_call') {
            pushCombatImpactVfx({
              kind: 'jhin_line',
              position: casterPos,
              casterId,
              skillId,
              targetPoint: resolvedTargetPoint,
              rotation: resolvedRotation,
              createdAt: now,
              expiresAt: now + (skillId === 'jhin_r_curtain_call' ? 520 : 360),
            });
          }
        }
      }

      if ((nextStage === 'finished' || nextStage === 'interrupted') && castInstanceId) {
        castPresentationContextRef.current.delete(castInstanceId);
      }

      /* interrupted 阶段：施法被打断，回滚预测状态 */
      if (nextStage === 'interrupted' && casterId) {
        useGameStore.getState().clearChampionAnimationClip(casterId);
        if (castInstanceId) {
          useGameStore.getState().clearLocalSpellPredictionByCastInstanceId(castInstanceId);
        }
        /* 如果有瞄准快照且为受控英雄，恢复瞄准态供玩家重试 */
        if (localPrediction?.aimSnapshot && casterId === controlledChampionIdRef.current) {
          useGameStore.getState().enterSpellAim(localPrediction.aimSnapshot);
        } else {
          /* 否则如果当前正在瞄准该英雄的技能，取消瞄准状态 */
          const currentAim = useGameStore.getState().spellAimState;
          if (currentAim && casterId === controlledChampionIdRef.current) {
            useGameStore.getState().exitSpellAim();
          }
        }
        console.log('[BattleWsSync] 施法被中断:', payload.castInstanceId, skillId);
      }

      /* finished 阶段：清除施法者的施法阶段状态及预测记录 */
      if (nextStage === 'finished' && casterId) {
        useGameStore.getState().clearChampionAnimationClip(casterId);
        if (castInstanceId) {
          useGameStore.getState().clearLocalSpellPredictionByCastInstanceId(castInstanceId);
        }
      }
    };
    socket.on('spellStageChanged', handleStageChanged);

    const handleChampionAnimate = (payload: Record<string, unknown>) => {
      const championId = payload.championId as string | undefined;
      const request = toAnimationClipRequest(payload.request);
      if (!championId || !request) {
        return;
      }
      useGameStore.getState().playChampionAnimationClip(championId, request);
    };
    socket.on('champion:animate', handleChampionAnimate);

    const handleChampionEmote = (payload: Record<string, unknown>) => {
      const championId = payload.championId as string | undefined;
      const emoteId = payload.emoteId as string | undefined;
      const durationMs = typeof payload.durationMs === 'number'
        ? payload.durationMs
        : GAME_CONFIG.emotes.worldDisplayDurationMs;
      if (!championId || !emoteId) {
        return;
      }
      useGameStore.getState().triggerChampionEmote(championId, emoteId, durationMs);
    };
    socket.on('champion:emote', handleChampionEmote);

    const handleChampionVoice = (payload: Record<string, unknown>) => {
      const championId = payload.championId as string | undefined;
      const request = toVoicePlaybackRequest(payload.request);
      if (!championId || !request) {
        return;
      }
      useGameStore.getState().setChampionVoiceRequest(championId, request);
    };
    socket.on('champion:voice', handleChampionVoice);

    const handleDamageApplied = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as DamageAppliedEvent;
      const amount = typeof event.amount === 'number' ? event.amount : 0;
      const targetEntityId = event.targetEntityId;
      const skillId = event.skillId;
      const position = resolveEventPosition(event.position, targetEntityId);
      const now = Date.now();
      pushFloatingCombatText({
        kind: 'damage',
        targetEntityId,
        position,
        amount,
        skillId,
        createdAt: now,
        expiresAt: now + 900,
      });
      pushCombatImpactVfx({
        kind: 'hit_flash',
        position,
        targetEntityId,
        skillId,
        createdAt: now,
        expiresAt: now + 220,
      });
    };
    socket.on('DamageApplied', handleDamageApplied);

    const handleHealApplied = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as HealAppliedEvent;
      const targetEntityId = event.targetEntityId;
      const position = resolveEventPosition(event.position, targetEntityId);
      const amount = typeof event.amount === 'number' ? event.amount : 0;
      const now = Date.now();
      pushFloatingCombatText({
        kind: 'heal',
        targetEntityId,
        position,
        amount,
        skillId: event.skillId,
        createdAt: now,
        expiresAt: now + 900,
      });
    };
    socket.on('HealApplied', handleHealApplied);

    const handleShieldChanged = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as ShieldChangedEvent;
      const delta = typeof event.delta === 'number' ? event.delta : 0;
      if (delta <= 0) {
        return;
      }
      const targetEntityId = event.targetEntityId;
      const position = resolveEventPosition(event.position, targetEntityId);
      const now = Date.now();
      pushFloatingCombatText({
        kind: 'shield',
        targetEntityId,
        position,
        amount: delta,
        skillId: event.skillId,
        createdAt: now,
        expiresAt: now + 900,
      });
    };
    socket.on('ShieldChanged', handleShieldChanged);

    const handleStatusApplied = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as StatusAppliedEvent;
      useGameStore.getState().upsertCombatStatus({
        statusInstanceId: event.statusInstanceId,
        statusId: event.statusId,
        sourceEntityId: event.sourceEntityId,
        targetEntityId: event.targetEntityId,
        stacks: event.stacks,
        durationMs: event.durationMs,
        expiresAt: event.expiresAt,
      });
    };
    socket.on('StatusApplied', handleStatusApplied);

    const handleStatusRemoved = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as StatusRemovedEvent;
      useGameStore.getState().removeCombatStatus(event.statusInstanceId, event.statusId, event.targetEntityId);
    };
    socket.on('StatusRemoved', handleStatusRemoved);

    const handleProjectileSpawned = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as ProjectileSpawnedEvent;
      useGameStore.getState().upsertProjectile({
        projectileId: event.projectileId,
        castInstanceId: event.castInstanceId ?? '',
        ownerId: event.ownerId,
        skillId: event.skillId,
        position: event.position,
        direction: event.direction,
        speed: event.speed,
        radius: event.radius,
        blockable: event.blockable,
      });
    };
    socket.on('ProjectileSpawned', handleProjectileSpawned);

    const handleProjectileDestroyed = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as ProjectileDestroyedEvent;
      useGameStore.getState().removeProjectile(event.projectileId);
      if (event.position) {
        const now = Date.now();
        pushCombatImpactVfx({
          kind: 'hit_flash',
          position: event.position,
          skillId: event.skillId,
          createdAt: now,
          expiresAt: now + 220,
        });
      }
    };
    socket.on('projectileDestroyed', handleProjectileDestroyed);

    const handleAreaCreated = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as AreaCreatedEvent;
      useGameStore.getState().upsertArea({
        areaId: event.areaId,
        castInstanceId: event.castInstanceId ?? '',
        ownerId: event.ownerId,
        skillId: event.skillId,
        areaType: event.areaType,
        position: event.position,
        radius: event.radius ?? 0,
        rotationY: event.rotationY,
        length: event.length,
        width: event.width,
        height: event.height,
        expiresAt: event.expiresAt,
      });
      if (event.areaType === 'wind_wall') {
        const now = Date.now();
        pushCombatImpactVfx({
          kind: 'wind_wall_spawn',
          position: event.position,
          casterId: event.ownerId,
          skillId: event.skillId,
          rotation: event.rotationY,
          createdAt: now,
          expiresAt: now + 420,
        });
      }
    };
    socket.on('AreaCreated', handleAreaCreated);

    const handleAreaExpired = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as AreaExpiredEvent;
      useGameStore.getState().removeArea(event.areaId);
    };
    socket.on('areaExpired', handleAreaExpired);

    const handleDisplacementResolved = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as DisplacementResolvedEvent;
      if (event.targetEntityId && event.position) {
        useGameStore.getState().applyAuthoritativeDisplacement(
          event.targetEntityId,
          event.position,
          event.movementLockedUntil,
        );
      }
    };
    socket.on('DisplacementResolved', handleDisplacementResolved);

    /**
     * 死亡事件：服务端通知某个英雄死亡。
     * 触发死亡动画、生成死亡飘字，并清理瞄准状态。
     */
    const handleDeathOccurred = (payload: Record<string, unknown>) => {
      if (!shouldConsumeOrderedEvent(payload, lastProcessedEventSequenceRef)) {
        return;
      }
      const event = payload as unknown as DeathOccurredEvent;
      const targetEntityId = event.targetEntityId;
      if (!targetEntityId) return;

      /* 播放死亡动画 */
      useGameStore.getState().setChampionAnimationState(targetEntityId, 'death');
      useGameStore.getState().clearChampionAnimationClip(targetEntityId);

      /* 生成死亡飘字 */
      const position = resolveEventPosition(event.position, targetEntityId);
      const now = Date.now();
      pushFloatingCombatText({
        kind: 'damage',
        targetEntityId,
        position,
        amount: 0,
        skillId: event.skillId,
        createdAt: now,
        expiresAt: now + 1200,
      });

      /* 如果死亡的是当前控制的英雄，取消瞄准状态 */
      if (targetEntityId === controlledChampionIdRef.current) {
        useGameStore.getState().exitSpellAim();
      }

      console.log('[BattleWsSync] 英雄死亡:', targetEntityId, '击杀者:', event.sourceEntityId);
    };
    socket.on('DeathOccurred', handleDeathOccurred);

    /* 连接 Socket.IO 服务器 */
    connectToBattleSocket(playerName);

    /* 清理：卸载时移除所有事件监听并断开连接 */
    return () => {
      cancelAnimationFrame(flushRafId);
      snapshotQueueRef.current = [];
      castPresentationContextRef.current.clear();
      updateDiagnostics({ bufferedSnapshotCount: 0 });
      /* Socket.IO 生命周期事件 */
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.io.off('reconnect', handleReconnect);
      socket.io.off('reconnect_attempt', handleReconnectAttempt);
      socket.io.off('reconnect_failed', handleReconnectFailed);
      /* 业务事件 */
      socket.off('room:joined', handleJoined);
      socket.off('combatSnapshot', handleSnapshot);
      socket.off('spellCastAccepted', handleAccepted);
      socket.off('spellCastRejected', handleRejected);
      socket.off('spellCastStarted', handleStarted);
      socket.off('spellStageChanged', handleStageChanged);
      socket.off('champion:animate', handleChampionAnimate);
      socket.off('champion:emote', handleChampionEmote);
      socket.off('champion:voice', handleChampionVoice);
      socket.off('DamageApplied', handleDamageApplied);
      socket.off('HealApplied', handleHealApplied);
      socket.off('ShieldChanged', handleShieldChanged);
      socket.off('StatusApplied', handleStatusApplied);
      socket.off('StatusRemoved', handleStatusRemoved);
      socket.off('ProjectileSpawned', handleProjectileSpawned);
      socket.off('projectileDestroyed', handleProjectileDestroyed);
      socket.off('AreaCreated', handleAreaCreated);
      socket.off('areaExpired', handleAreaExpired);
      socket.off('DisplacementResolved', handleDisplacementResolved);
      socket.off('DeathOccurred', handleDeathOccurred);
      disconnectBattleSocket();
    };
  }, [enabled, playerName]);
}

// ==================== 辅助函数 ====================

/**
 * 根据技能槽位和施法者构建前端施法动画请求。
 * 优先从英雄资源配置（HeroAnimationConfig）获取动画参数，
 * 未配置时回退到通用默认映射：
 *   Q/E/basicAttack → attack 动画，W/R → cast 动画。
 */
function buildCastAnimationRequest(slot: string, _skillId: string, casterId?: string): AnimationClipRequest | null {
  const actionSlot = slot as HeroActionSlot;

  /* 尝试从英雄资源配置获取动画参数 */
  if (casterId) {
    const caster = useGameStore.getState().champions.find((c) => c.id === casterId);
    if (caster) {
      const heroAction = getHeroActionConfig(caster.heroId, actionSlot);
      if (heroAction.clipName) {
        return {
          actionSlot,
          clipName: heroAction.clipName,
          loop: false,
          playbackRate: heroAction.playbackRate ?? 1,
          reset: true,
          durationMs: heroAction.durationMs ?? 500,
          lockMovement: heroAction.lockMovement ?? true,
          fallbackState: 'idle',
          nonce: Date.now() + Math.random(),
        };
      }
    }
  }

  /* 通用默认映射（未配置英雄资源时的后备方案） */
  let clipName = 'cast';
  let durationMs = 600;
  let lockMovement = true;

  switch (slot) {
    case 'q':
      clipName = 'attack';
      durationMs = 400;
      lockMovement = true;
      break;
    case 'w':
      clipName = 'cast';
      durationMs = 500;
      lockMovement = true;
      break;
    case 'e':
      clipName = 'attack';
      durationMs = 350;
      lockMovement = false;
      break;
    case 'r':
      clipName = 'cast';
      durationMs = 800;
      lockMovement = true;
      break;
    case 'basicAttack':
      clipName = 'attack';
      durationMs = 350;
      lockMovement = true;
      break;
    default:
      return null;
  }

  return {
    actionSlot,
    clipName,
    loop: false,
    playbackRate: 1,
    reset: true,
    durationMs,
    lockMovement,
    fallbackState: 'idle',
    nonce: Date.now() + Math.random(),
  };
}

/**
 * 将技能槽位映射为语音播放槽位。
 * 确保 Q/W/E/R 和普攻均能触发对应的技能语音。
 */
function mapSlotToVoiceSlot(slot: string): VoicePlaybackSlot | null {
  switch (slot) {
    case 'q':
    case 'w':
    case 'e':
    case 'r':
    case 'basicAttack':
    case 'recall':
      return slot;
    default:
      return null;
  }
}
