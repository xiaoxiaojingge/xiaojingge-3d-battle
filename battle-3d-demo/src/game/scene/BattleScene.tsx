import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { GAME_CONFIG } from '../../config/gameConfig';
import { useGameStore } from '../../store/useGameStore';
import Lights from './Lights';
import CameraController from './CameraController';
import PostProcessingEffects from '../effects/PostProcessing';
import BattleMap from '../world/BattleMap';
import Bushes from '../world/Bushes';
import Fountains from '../world/Fountains';
import MoveIndicator from '../world/MoveIndicator';
import Towers from '../world/Towers';
import Nexuses from '../world/Nexuses';
import Inhibitors from '../world/Inhibitors';
import HealthRelics from '../world/HealthRelics';
import SnowParticles from '../world/SnowParticles';
import Champions from '../models/Champions';
import InputController from '../systems/InputController';
import WorldDebugLabels from '../debug/WorldDebugLabels';
import { Perf } from 'r3f-perf';
import { RENDER_CONFIG } from '../../config/renderConfig';
import DebugHitboxOverlay from '../debug/DebugHitboxOverlay';
import ProjectileRenderer from '../effects/ProjectileRenderer';
import AreaEffectRenderer from '../effects/AreaEffectRenderer';
import SkillVfxSystem from '../effects/SkillVfxSystem';
import FloatingCombatTextSystem from '../effects/FloatingCombatTextSystem';
import SpellAimIndicator from '../effects/SpellAimIndicator';

const BattleRuntimeController: React.FC = () => {
  const tickMovement = useGameStore((s) => s.tickMovement);
  const cleanupExpiredEmotes = useGameStore((s) => s.cleanupExpiredEmotes);
  const cleanupExpiredCombatFeedback = useGameStore((s) => s.cleanupExpiredCombatFeedback);
  const setMultiplayerDiagnosticsFps = useGameStore((s) => s.setMultiplayerDiagnosticsFps);
  const fpsAccumulatorRef = useRef({ elapsed: 0, frames: 0 });
  const emoteCleanupAccumulatorRef = useRef(0);
  const combatFeedbackCleanupAccumulatorRef = useRef(0);

  useFrame((_, delta) => {
    /* ── 过期表情清理（每 1 秒检查一次，降低高频 store 写入开销） ── */
    emoteCleanupAccumulatorRef.current += delta;
    if (emoteCleanupAccumulatorRef.current >= 1.0) {
      cleanupExpiredEmotes();
      emoteCleanupAccumulatorRef.current = 0;
    }

    /* ── 过期战斗反馈清理（每 0.5 秒检查一次） ── */
    combatFeedbackCleanupAccumulatorRef.current += delta;
    if (combatFeedbackCleanupAccumulatorRef.current >= 0.5) {
      cleanupExpiredCombatFeedback();
      combatFeedbackCleanupAccumulatorRef.current = 0;
    }

    /* ── 联机模式下 tickMovement 为 no-op，提前短路避免每帧空调用 set({}) ── */
    if (!GAME_CONFIG.multiplayer.enabled) {
      tickMovement(delta);
    }

    const bucket = fpsAccumulatorRef.current;
    bucket.elapsed += delta;
    bucket.frames += 1;

    if (bucket.elapsed >= 0.35) {
      setMultiplayerDiagnosticsFps(Math.round(bucket.frames / bucket.elapsed));
      bucket.elapsed = 0;
      bucket.frames = 0;
    }
  });

  return null;
};

const BattleScene: React.FC = () => {
  return (
    <>
      {/* 场景设置 */}
      <fog attach="fog" args={[0x0f2139, 40, 220]} />
      <color attach="background" args={[0x0d1b2e]} />

      {/* 摄像机控制 */}
      <CameraController />
      <InputController />
      <BattleRuntimeController />

      {/* 灯光 */}
      <Lights />

      {/* 地形 */}
      <BattleMap />
      <Bushes />
      <Fountains />
      <MoveIndicator />

      {/* 建筑 */}
      <Towers />
      <Nexuses />
      <Inhibitors />
      <HealthRelics />

      {/* 雪花粒子 */}
      <SnowParticles />

      {/* 英雄 */}
      <Champions />

      {/* 战斗实体：投射物和区域体 */}
      <ProjectileRenderer />
      <AreaEffectRenderer />

      {/* 技能视觉特效 */}
      <SkillVfxSystem />
      <FloatingCombatTextSystem />

      {/* 技能瞄准指示器 */}
      <SpellAimIndicator />

      <WorldDebugLabels />

      {/* 调试判定范围线框 */}
      <DebugHitboxOverlay />

      {/* 性能监控面板 */}
      {RENDER_CONFIG.showPerfMonitor && (
        <Perf position="bottom-left" />
      )}

      {/* 后处理 */}
      <PostProcessingEffects />
    </>
  );
};

export default BattleScene;
