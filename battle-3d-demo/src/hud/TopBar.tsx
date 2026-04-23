import React, { useEffect } from 'react';
import { GAME_CONFIG } from '../config/gameConfig';
import { useGameStore } from '../store/useGameStore';

const CAMERA_MODE_LABELS = {
  playerLocked: '玩家锁定',
  directorFree: '导播自由',
  spectatorFollow: '跟随观战',
} as const;

const TopBar: React.FC = () => {
  const blueKills = useGameStore((s) => s.blueKills);
  const redKills = useGameStore((s) => s.redKills);
  const gameTimer = useGameStore((s) => s.gameTimer);
  const updateGameTimer = useGameStore((s) => s.updateGameTimer);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const showWorldCoordinates = useGameStore((s) => s.showWorldCoordinates);
  const multiplayerSession = useGameStore((s) => s.multiplayerSession);
  const currentTargetName = useGameStore((s) => {
    const currentTarget = s.spectatorTargetId
      ? s.champions.find((champion) => champion.id === s.spectatorTargetId) ?? null
      : s.champions.find((champion) => champion.isMe) ?? null;
    return currentTarget?.playerName ?? null;
  });
  const multiplayerEnabled = GAME_CONFIG.multiplayer.enabled;

  useEffect(() => {
    if (multiplayerEnabled) {
      return;
    }

    const interval = setInterval(() => {
      updateGameTimer(1);
    }, 1000);
    return () => clearInterval(interval);
  }, [multiplayerEnabled, updateGameTimer]);

  const displaySeconds = Math.max(0, Math.floor(gameTimer));
  const minutes = Math.floor(displaySeconds / 60).toString().padStart(2, '0');
  const seconds = (displaySeconds % 60).toString().padStart(2, '0');

  const diagnostics = multiplayerSession.diagnostics;
  const connectedPlayers = multiplayerSession.players.filter((player) => !player.isSpectator).length;
  const spectatorPlayers = multiplayerSession.players.filter((player) => player.isSpectator).length;
  const latencyText = diagnostics.snapshotLatencyMs == null
    ? '--'.padStart(3, ' ')
    : `${Math.round(diagnostics.snapshotLatencyMs)}`.padStart(3, ' ');
  const seqText = `${diagnostics.lastAppliedSequence}`.padStart(4, ' ');
  const onlineText = `${connectedPlayers}`.padStart(2, ' ');
  const spectatorText = `${spectatorPlayers}`.padStart(2, ' ');
  const droppedText = `${diagnostics.droppedSnapshotCount}`.padStart(4, ' ');

  return (
    <div className="absolute top-0 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4 py-1.5 px-6 rounded-b-xl"
      style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 100%)' }}>
      {/* 蓝队击杀 */}
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-game-blue shadow-[0_0_6px_rgba(100,181,246,0.8)]" />
        <span className="text-game-blue font-bold text-xl min-w-[24px] text-center">{blueKills}</span>
      </div>

      {/* 计时器 */}
      <div className="text-white/60 text-sm font-mono tracking-wider px-3 border-x border-white/10">
        {minutes}:{seconds}
      </div>

      <div className="hidden md:flex items-center gap-2 text-[11px]">
        <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2 py-1 text-cyan-100">
          {CAMERA_MODE_LABELS[cameraMode]}
        </span>
        {GAME_CONFIG.multiplayer.showDiagnosticsPanel && (
          <>
            <span className={`rounded-full border px-2 py-1 ${
              !multiplayerEnabled
                ? 'border-white/10 bg-white/5 text-white/65'
                : multiplayerSession.status === 'connected'
                  ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                  : multiplayerSession.status === 'connecting'
                    ? 'border-amber-300/25 bg-amber-400/10 text-amber-100'
                    : 'border-red-300/25 bg-red-400/10 text-red-100'
            }`}>
              联机：{multiplayerEnabled ? (
                multiplayerSession.status === 'connected' ? '已连接'
                  : multiplayerSession.status === 'connecting' ? '连接中...'
                  : multiplayerSession.status === 'disconnected' ? '已离线'
                  : multiplayerSession.status === 'error' ? '连接中断'
                  : '关闭'
              ) : '关闭'}
            </span>
            {GAME_CONFIG.multiplayer.showFps && (
              <span className="rounded-full border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-amber-100">
                FPS：{diagnostics.fps || '--'}
              </span>
            )}
            {multiplayerEnabled && (
              <span className="rounded-full border border-fuchsia-300/25 bg-fuchsia-400/10 px-2 py-1 font-mono text-fuchsia-100 tabular-nums min-w-[176px] text-center">
                延迟：{latencyText}ms / Seq：{seqText}
              </span>
            )}
            {multiplayerEnabled && (
              <span className="rounded-full border border-sky-300/25 bg-sky-400/10 px-2 py-1 font-mono text-sky-100 tabular-nums min-w-[148px] text-center">
                在线：{onlineText} / 观战：{spectatorText}
              </span>
            )}
            {multiplayerEnabled && (
              <span className="rounded-full border border-rose-300/25 bg-rose-400/10 px-2 py-1 font-mono text-rose-100 tabular-nums min-w-[132px] text-center">
                丢弃快照：{droppedText}
              </span>
            )}
          </>
        )}
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/75">
          焦点：{currentTargetName ?? '无'}
        </span>
        <span className={`rounded-full border px-2 py-1 ${showWorldCoordinates ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100' : 'border-white/10 bg-white/5 text-white/55'}`}>
          坐标：{showWorldCoordinates ? '开' : '关'}
        </span>
      </div>

      {/* 红队击杀 */}
      <div className="flex items-center gap-2">
        <span className="text-game-red font-bold text-xl min-w-[24px] text-center">{redKills}</span>
        <div className="w-2 h-2 rounded-full bg-game-red shadow-[0_0_6px_rgba(239,83,80,0.8)]" />
      </div>
    </div>
  );
};

export default TopBar;
