import React, { useEffect } from 'react';
import { GAME_CONFIG } from './config/gameConfig';
import { getHeroActionConfig } from './config/heroConfig';
import BattleCanvas from './game/BattleCanvas';
import HUD from './hud/HUD';
import { emitAnimationCommand } from './network/socketClient';
import { useBattleWsSync } from './network/useBattleWsSync';
import { useGameStore } from './store/useGameStore';

const App: React.FC = () => {
  const clearChampionAnimationClip = useGameStore((s) => s.clearChampionAnimationClip);
  const playChampionAnimationClip = useGameStore((s) => s.playChampionAnimationClip);
  const setChampionAnimationState = useGameStore((s) => s.setChampionAnimationState);
  const controlledLineupItem = GAME_CONFIG.heroes.lineup.find((item) => item.isControlled) ?? null;
  const debugChampion = useGameStore((s) => s.champions.find((champion) => champion.isMe)
    || s.champions.find((champion) => champion.team === controlledLineupItem?.team
      && champion.heroId === controlledLineupItem?.heroId
      && champion.playerName.replace(/\(我\)$/, '') === controlledLineupItem?.playerName)
    || null);
  const multiplayerEnabled = GAME_CONFIG.multiplayer.enabled;

  const cameraMode = useGameStore((s) => s.cameraMode);
  const debugFreeCamera = useGameStore((s) => s.debugFreeCamera);

  /* 统一使用 Socket.IO 同步 Hook（已移除 transport 分支） */
  useBattleWsSync(
    multiplayerEnabled,
    controlledLineupItem?.playerName ?? 'Player',
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    if (!debugChampion) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (cameraMode !== 'playerLocked' || debugFreeCamera) return;

      const slot = GAME_CONFIG.debug.animationHotkeys[event.code as keyof typeof GAME_CONFIG.debug.animationHotkeys];
      const actionConfig = slot ? getHeroActionConfig(debugChampion.heroId, slot) : null;
      if (actionConfig?.clipName) {
        const request = {
          actionSlot: actionConfig.actionSlot,
          clipName: actionConfig.clipName,
          loop: false,
          playbackRate: actionConfig.playbackRate,
          reset: true,
          durationMs: actionConfig.durationMs,
          lockMovement: actionConfig.lockMovement,
          fallbackState: 'idle' as const,
          nonce: Date.now() + Math.random(),
        };

        if (multiplayerEnabled) {
          emitAnimationCommand({
            championId: debugChampion.id,
            request,
          });
        } else {
          playChampionAnimationClip(debugChampion.id, request);
        }
      }
      if (event.key === '0') {
        clearChampionAnimationClip(debugChampion.id);
        setChampionAnimationState(debugChampion.id, 'idle');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cameraMode, clearChampionAnimationClip, debugChampion, debugFreeCamera, multiplayerEnabled, playChampionAnimationClip, setChampionAnimationState]);

  /* 过期战斗反馈与表情数据的清理已由 BattleRuntimeController（useFrame 循环）统一负责，
   * 此处不再重复设置 setInterval，避免双重清理带来的额外 store 写入开销。 */

  return (
    <div className="relative w-full h-full overflow-hidden select-none">
      <BattleCanvas />
      <HUD />
    </div>
  );
};

export default App;
