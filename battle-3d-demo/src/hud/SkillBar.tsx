import React, { useCallback, useEffect, useMemo } from 'react';
import { getHeroActionConfig } from '../config/heroConfig';
import { useGameStore } from '../store/useGameStore';
import { emitCastSpell, emitBasicAttack, getSocketClient } from '../network/socketClient';
import { getSkillCastDefinition, requiresAiming } from '../config/skillDefinitions';
import type { HeroActionSlot, SkillRuntimeState, SpellAimState, SpellSlot, VoicePlaybackSlot } from '../types/game';

/** 技能槽位 → 快捷键映射 */
const SLOT_KEY_MAP: Record<string, string> = {
  passive: 'P',
  basicAttack: 'A',
  q: 'Q',
  w: 'W',
  e: 'E',
  r: 'R',
  summonerD: 'D',
  summonerF: 'F',
  recall: 'B',
};

/** 技能槽位 → 显示颜色 */
const SLOT_COLOR_MAP: Record<string, string> = {
  passive: '#8888aa',
  basicAttack: '#aaaacc',
  q: '#64b5f6',
  w: '#81c784',
  e: '#ce93d8',
  r: '#ef5350',
  summonerD: '#ffd54f',
  summonerF: '#4dd0e1',
  recall: '#90a4ae',
};

/** 显示在技能栏中的槽位顺序 */
const DISPLAY_SLOTS: SpellSlot[] = ['passive', 'q', 'w', 'e', 'r', 'summonerD', 'summonerF'];

/** 可由键盘触发施法的槽位集合 */
const CASTABLE_SLOTS = new Set<string>(['q', 'w', 'e', 'r', 'summonerD', 'summonerF', 'basicAttack']);

/** 键盘按键 → 技能槽位反向映射 */
const KEY_TO_SLOT: Record<string, SpellSlot> = {
  q: 'q',
  w: 'w',
  e: 'e',
  r: 'r',
  d: 'summonerD',
  f: 'summonerF',
  a: 'basicAttack',
  b: 'recall',
};

/**
 * 生成唯一的施法请求 ID。
 */
let castSeq = 0;
function nextRequestId(): string {
  return `cast_${Date.now()}_${++castSeq}`;
}

function mapSpellSlotToActionSlot(slot: SpellSlot): HeroActionSlot | null {
  switch (slot) {
    case 'basicAttack':
    case 'q':
    case 'w':
    case 'e':
    case 'r':
    case 'recall':
      return slot;
    default:
      return null;
  }
}

function mapSpellSlotToVoiceSlot(slot: SpellSlot): VoicePlaybackSlot | null {
  switch (slot) {
    case 'basicAttack':
    case 'q':
    case 'w':
    case 'e':
    case 'r':
    case 'recall':
      return slot;
    default:
      return null;
  }
}

interface LocalCastPayload {
  roomId: string | null;
  requestId: string;
  casterId: string;
  slot: SpellSlot;
  skillId?: string;
  targetEntityId?: string;
  targetPoint?: { x: number; y: number; z: number };
  targetDirection?: { x: number; y: number; z: number };
  clientTimestamp: number;
}

const SkillBar: React.FC = () => {
  const champions = useGameStore((s) => s.champions);
  const multiplayerSession = useGameStore((s) => s.multiplayerSession);
  const spellAimState = useGameStore((s) => s.spellAimState);
  const me = useMemo(() => champions.find((c) => c.isMe) ?? null, [champions]);

  /** 当前受控英雄的技能状态列表（按显示顺序） */
  const displaySkills = useMemo(() => {
    if (!me?.skillStates) return [];
    return DISPLAY_SLOTS.map((slot) => {
      const state: SkillRuntimeState | undefined = me.skillStates[slot];
      return {
        slot,
        key: SLOT_KEY_MAP[slot] ?? slot.toUpperCase(),
        label: state?.name ?? (SLOT_KEY_MAP[slot] ?? slot),
        cooldown: state ? state.remainingCooldownMs / 1000 : 0,
        maxCooldown: state ? state.maxCooldownMs / 1000 : 0,
        isReady: state?.isReady ?? true,
        color: SLOT_COLOR_MAP[slot] ?? '#888',
      };
    });
  }, [me]);

  /**
   * 执行施法请求（发送到服务端 + 客户端预测动画和语音）。
   * 此函数在瞄准确认后或自动施法时调用。
   */
  const executeCast = useCallback(
    (slot: SpellSlot, aimState?: SpellAimState | null) => {
      if (!me) return false;
      if (!getSocketClient().connected) return false;

      const skillState = me.skillStates?.[slot];
      const activeAim = aimState ?? useGameStore.getState().spellAimState;
      const payload: LocalCastPayload = {
        roomId: multiplayerSession.roomId,
        requestId: nextRequestId(),
        casterId: me.id,
        slot,
        skillId: skillState?.skillId ?? slot,
        clientTimestamp: Date.now(),
      };

      /* ===== 根据正式瞄准状态组装目标参数 ===== */
      if (activeAim && activeAim.slot === slot) {
        if (activeAim.targetType === 'target_unit') {
          if (!activeAim.targetEntityId) {
            return false;
          }
          payload.targetEntityId = activeAim.targetEntityId;
        }

        if (activeAim.targetType === 'target_point') {
          if (!activeAim.targetPoint) {
            return false;
          }
          payload.targetPoint = activeAim.targetPoint;
        }

        if (activeAim.targetType === 'directional') {
          if (!activeAim.targetPoint || !activeAim.targetDirection) {
            return false;
          }
          payload.targetPoint = activeAim.targetPoint;
          payload.targetDirection = activeAim.targetDirection;
        }
      }

      const sendSucceeded = slot === 'basicAttack'
        ? emitBasicAttack(payload)
        : emitCastSpell(payload);

      if (!sendSucceeded) {
        return false;
      }

      const requestId = payload.requestId;
      const castSkillId = payload.skillId ?? slot;

      /* ===== 登记本地施法预测记录，供后续服务端事件对账 ===== */
      const restoredAimSnapshot = activeAim
        ? {
            ...activeAim,
            /* target_unit 释放后目标已消耗，恢复瞄准时不保留旧目标 */
            targetEntityId: activeAim.targetType === 'target_unit' ? null : (activeAim.targetEntityId ?? null),
          }
        : null;
      useGameStore.getState().registerLocalSpellPrediction({
        requestId,
        casterId: me.id,
        slot,
        skillId: castSkillId,
        createdAt: Date.now(),
        castInstanceId: null,
        status: 'pending',
        aimSnapshot: restoredAimSnapshot,
      });

      /* ===== 客户端预测：施法时英雄立即转向鼠标方向 ===== */
      if (activeAim && (activeAim.targetPoint || activeAim.cursorWorldPosition)) {
        const aimTarget = activeAim.targetPoint ?? activeAim.cursorWorldPosition;
        if (aimTarget) {
          const dx = aimTarget.x - me.position.x;
          const dz = aimTarget.z - me.position.z;
          if (dx * dx + dz * dz > 0.001) {
            const facingRotation = Math.atan2(dx, dz);
            useGameStore.getState().setChampionFacingRotation(me.id, facingRotation);
          }
        }
      }

      /* ===== 客户端预测：立即播放施法动画，提升操作手感 ===== */
      const animClipName = (slot === 'q' || slot === 'e' || slot === 'basicAttack') ? 'attack' : 'cast';
      const animDuration = slot === 'r' ? 800 : slot === 'w' ? 500 : 400;
      const actionSlot = mapSpellSlotToActionSlot(slot);
      if (actionSlot) {
        const actionConfig = getHeroActionConfig(me.heroId, actionSlot);
        useGameStore.getState().playChampionAnimationClip(me.id, {
          actionSlot: actionConfig.actionSlot,
          clipName: actionConfig.clipName || animClipName,
          loop: false,
          playbackRate: actionConfig.playbackRate ?? 1,
          reset: true,
          durationMs: actionConfig.durationMs ?? animDuration,
          lockMovement: actionConfig.lockMovement ?? slot !== 'e',
          fallbackState: 'idle',
          nonce: Date.now() + Math.random(),
        });
      }

      /* 客户端预测：触发技能语音 */
      const voiceSlot = mapSpellSlotToVoiceSlot(slot);
      if (voiceSlot) {
        useGameStore.getState().setChampionVoiceRequest(me.id, {
          slot: voiceSlot,
          nonce: Date.now() + Math.random(),
        });
      }

      return true;
    },
    [me, multiplayerSession.roomId],
  );

  /**
   * 处理技能按键/点击：
   *   - self_cast / 无需瞄准 → 直接释放
   *   - 需要瞄准 → 进入瞄准模式（重复按同一技能键 → 取消瞄准）
   */
  const handleSkillInput = useCallback(
    (slot: SpellSlot) => {
      if (!me || !CASTABLE_SLOTS.has(slot)) return;
      if (!getSocketClient().connected) return;

      const skillState = me.skillStates?.[slot];
      if (skillState && !skillState.isReady) return;

      /* 若当前正在瞄准同一技能，则取消瞄准（切换行为） */
      const currentAim = useGameStore.getState().spellAimState;
      if (currentAim && currentAim.slot === slot) {
        useGameStore.getState().exitSpellAim();
        return;
      }

      /* 检查是否需要瞄准 */
      if (!requiresAiming(me.heroId, slot)) {
        /* 不需要瞄准的技能（self_cast、回城等）直接释放 */
        useGameStore.getState().exitSpellAim();
        executeCast(slot);
        return;
      }

      /* 进入瞄准模式 */
      const castDef = getSkillCastDefinition(me.heroId, slot);
      if (!castDef) {
        /* 无施法参数定义，降级为直接释放 */
        executeCast(slot);
        return;
      }

      useGameStore.getState().enterSpellAim({
        slot,
        casterId: me.id,
        skillId: castDef.skillId,
        targetType: castDef.targetType,
        range: castDef.range,
        radius: castDef.radius,
        width: castDef.width,
        targetRules: castDef.targetRules ?? null,
        cursorWorldPosition: null,
        targetPoint: null,
        targetDirection: null,
        hoveredTargetEntityId: null,
        hoveredTargetAllowed: null,
        targetEntityId: null,
      });
    },
    [me, executeCast],
  );

  /**
   * 瞄准模式下的左键确认施法。
   * 监听全局 mousedown，在瞄准状态下左键点击触发释放。
   */
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const aim = useGameStore.getState().spellAimState;
      if (!aim) return;

      /* 仅处理 canvas 上的点击，忽略 HUD 按钮上的点击 */
      const target = e.target as HTMLElement;
      if (target.tagName !== 'CANVAS') return;

      /* 左键：确认施法 */
      if (e.button === 0) {
        /* target_unit 必须点中单位后才能释放，这里不接受点地面确认。 */
        if (aim.targetType !== 'target_unit') {
          if (executeCast(aim.slot, aim)) {
            useGameStore.getState().exitSpellAim();
          }
        }
      }
      /* 右键：取消瞄准（右键移动由 InputController 处理，不冲突） */
      if (e.button === 2) {
        useGameStore.getState().exitSpellAim();
      }
    };

    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [executeCast]);

  /**
   * target_unit 由 InputController 先完成单位拾取，再由这里统一正式释放。
   * 这样可以避免 HUD 与场景层同时各自发请求，保证单体技能确认路径唯一。
   */
  useEffect(() => {
    if (!spellAimState || spellAimState.targetType !== 'target_unit' || !spellAimState.targetEntityId) {
      return;
    }
    if (executeCast(spellAimState.slot, spellAimState)) {
      useGameStore.getState().exitSpellAim();
    }
  }, [executeCast, spellAimState]);

  /** 键盘监听：技能键 + ESC 取消 */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      /* 忽略输入框内的按键 */
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      /* 忽略浏览器自动重复派发的长按事件，避免技能键持续闪烁。 */
      if (e.repeat) return;

      /* ESC 取消瞄准 */
      if (e.key === 'Escape') {
        const aim = useGameStore.getState().spellAimState;
        if (aim) {
          useGameStore.getState().exitSpellAim();
          return;
        }
      }

      const slot = KEY_TO_SLOT[e.key.toLowerCase()];
      if (slot) {
        handleSkillInput(slot);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSkillInput]);

  /** 当前正在瞄准的技能槽位（用于高亮显示） */
  const aimingSlot = spellAimState?.slot ?? null;
  const aimHintText = useMemo(() => {
    if (spellAimState?.targetType !== 'target_unit') {
      return '左键确认 · 右键/ESC取消';
    }
    if (spellAimState.targetRules?.allyOnly) {
      return spellAimState.targetRules.allowSelf
        ? '左键点己方/自己确认 · 右键/ESC取消'
        : '左键点己方单位确认 · 右键/ESC取消';
    }
    if (spellAimState.targetRules?.enemyOnly) {
      return '左键点敌方单位确认 · 右键/ESC取消';
    }
    return '左键点目标单位确认 · 右键/ESC取消';
  }, [spellAimState]);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[100] flex items-end gap-1.5">
      {displaySkills.map((skill) => {
        const cdPercent = skill.maxCooldown > 0 ? skill.cooldown / skill.maxCooldown : 0;
        const isAiming = aimingSlot === skill.slot;
        return (
          <div
            key={skill.slot}
            className="flex flex-col items-center gap-1"
            onClick={() => handleSkillInput(skill.slot)}
          >
            {/* 技能图标 */}
            <div
              className="relative w-12 h-12 rounded-lg flex items-center justify-center transition-all hover:scale-105 select-none cursor-pointer"
              style={{
                background: isAiming
                  ? `linear-gradient(135deg, ${skill.color}66, ${skill.color}33)`
                  : skill.isReady
                    ? `linear-gradient(135deg, ${skill.color}33, ${skill.color}11)`
                    : 'rgba(0,0,0,0.6)',
                border: `2px solid ${isAiming ? skill.color : skill.isReady ? skill.color + '88' : '#333'}`,
                boxShadow: isAiming
                  ? `0 0 14px ${skill.color}88, inset 0 0 8px ${skill.color}44`
                  : skill.isReady
                    ? `0 0 8px ${skill.color}44`
                    : 'none',
              }}
            >
              {/* CD遮罩 */}
              {!skill.isReady && cdPercent > 0 && (
                <div
                  className="absolute inset-0 rounded-lg"
                  style={{
                    background: 'rgba(0,0,0,0.5)',
                    clipPath: `polygon(50% 50%, 50% 0%, ${50 + 50 * Math.sin(cdPercent * Math.PI * 2)}% ${50 - 50 * Math.cos(cdPercent * Math.PI * 2)}%, 50% 50%)`,
                  }}
                />
              )}

              <span
                className="text-sm font-bold z-10"
                style={{ color: isAiming ? '#fff' : skill.isReady ? skill.color : '#666' }}
              >
                {skill.label}
              </span>

              {/* CD 文字 */}
              {!skill.isReady && skill.cooldown > 0 && (
                <span className="absolute text-xs font-bold text-white/80 z-10">
                  {Math.ceil(skill.cooldown)}
                </span>
              )}

              {/* 瞄准态标识 */}
              {isAiming && (
                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full animate-pulse"
                  style={{ background: skill.color, boxShadow: `0 0 6px ${skill.color}` }}
                />
              )}
            </div>

            {/* 快捷键 */}
            <span className="text-[9px] text-white/30 font-mono">{skill.key}</span>
          </div>
        );
      })}

      {/* 瞄准模式提示文字 */}
      {aimingSlot && (
        <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded-md">
          {aimHintText}
        </div>
      )}
    </div>
  );
};

export default SkillBar;
