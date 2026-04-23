/**
 * 统一 Socket.IO 客户端（对接 battle-3d-demo-server 的 netty-socketio 网关）。
 * 职责：
 *   1. 管理 Socket.IO 连接生命周期（连接、断开、自动重连）
 *   2. 发送战斗消息（移动、停止、施法、普攻、动画、表情、语音）
 *   3. 暴露底层 Socket 实例供上层 Hook 注册事件监听
 *
 * 传输层仅使用 WebSocket，跳过 HTTP 长轮询以降低延迟。
 */

import { io, type Socket } from 'socket.io-client';
import { GAME_CONFIG } from '../config/gameConfig';
import type {
  AnimationCommandPayload,
  EmoteCommandPayload,
  MoveCommandPayload,
  VoiceCommandPayload,
} from '../types/game';

// ==================== 施法请求载荷类型 ====================

/** 施法请求载荷（从 battleWsClient.ts 迁移） */
export interface CastSpellPayload {
  /** 请求 ID（客户端生成，用于追踪施法结果） */
  requestId: string;
  /** 施法者 ID */
  casterId: string;
  /** 技能槽位（如 Q/W/E/R/basicAttack） */
  slot: string;
  /** 技能定义 ID（可选） */
  skillId?: string;
  /** 目标实体 ID（单体技能） */
  targetEntityId?: string;
  /** 目标点坐标（方向/范围技能） */
  targetPoint?: { x: number; y: number; z: number };
  /** 目标方向（方向技能） */
  targetDirection?: { x: number; y: number; z: number };
  /** 客户端时间戳 */
  clientTimestamp?: number;
}

// ==================== 内部状态 ====================

let socket: Socket | null = null;
let pendingJoinPlayerName: string | undefined;
let joinBindingInitialized = false;

/**
 * 内部辅助：仅在已连接且联机启用时发送事件。
 */
function emitWhenConnected<T extends unknown[]>(eventName: string, ...args: T): boolean {
  if (!GAME_CONFIG.multiplayer.enabled) {
    return false;
  }

  const client = getSocketClient();
  if (!client.connected) {
    return false;
  }

  client.emit(eventName, ...args);
  return true;
}

// ==================== 连接管理 ====================

/**
 * 获取 Socket.IO 服务器 URL。
 * 优先使用环境变量 VITE_SOCKET_SERVER_URL。
 */
export function getSocketServerUrl(): string {
  return import.meta.env.VITE_SOCKET_SERVER_URL || GAME_CONFIG.multiplayer.socketServerUrl;
}

/**
 * 获取或创建 Socket.IO 客户端单例。
 * 仅使用 WebSocket 传输，避免 HTTP 轮询带来的额外延迟。
 */
export function getSocketClient(): Socket {
  if (socket) {
    return socket;
  }

  socket = io(getSocketServerUrl(), {
    autoConnect: false,
    transports: ['websocket'],
    /* 断线重连配置：避免无限快速重连 */
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
  });

  if (!joinBindingInitialized) {
    socket.on('connect', () => {
      if (!GAME_CONFIG.multiplayer.enabled) {
        return;
      }
      socket?.emit('room:join', { playerName: pendingJoinPlayerName });
    });
    joinBindingInitialized = true;
  }

  return socket;
}

/**
 * 连接到战斗 Socket.IO 服务器。
 * 连接成功后自动发送 room:join 事件。
 */
export function connectToBattleSocket(playerName?: string) {
  if (!GAME_CONFIG.multiplayer.enabled) {
    return null;
  }

  const client = getSocketClient();
  pendingJoinPlayerName = playerName;
  if (!client.connected) {
    client.connect();
    return client;
  }
  client.emit('room:join', { playerName: pendingJoinPlayerName });
  return client;
}

/**
 * 断开战斗 Socket.IO 连接。
 */
export function disconnectBattleSocket() {
  if (!socket) {
    return;
  }
  pendingJoinPlayerName = undefined;
  socket.disconnect();
}

// ==================== 战斗命令 ====================

/** 发送英雄移动指令 */
export function emitMoveCommand(payload: MoveCommandPayload) {
  emitWhenConnected('champion:move', payload);
}

/** 发送英雄停止指令 */
export function emitStopCommand(payload: { championId: string }) {
  emitWhenConnected('champion:stop', payload);
}

/** 发送施法指令 */
export function emitCastSpell(payload: CastSpellPayload): boolean {
  return emitWhenConnected('castSpell', payload);
}

/** 发送普攻指令 */
export function emitBasicAttack(payload: CastSpellPayload): boolean {
  return emitWhenConnected('basicAttack', payload);
}

/** 发送动画指令 */
export function emitAnimationCommand(payload: AnimationCommandPayload) {
  emitWhenConnected('champion:animate', payload);
}

/** 发送表情指令 */
export function emitEmoteCommand(payload: EmoteCommandPayload) {
  emitWhenConnected('champion:emote', payload);
}

/** 发送语音指令 */
export function emitVoiceCommand(payload: VoiceCommandPayload) {
  emitWhenConnected('champion:voice', payload);
}
