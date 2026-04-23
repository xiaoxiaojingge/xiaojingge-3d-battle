import React from 'react';
import { GAME_CONFIG } from '../config/gameConfig';
import { useGameStore } from '../store/useGameStore';
import TopBar from './TopBar';
import SkillBar from './SkillBar';
import EmoteWheel from './EmoteWheel';
import HealthManaBar from './HealthManaBar';
import Scoreboard from './Scoreboard';
import MiniMap from './MiniMap';
import KillFeed from './KillFeed';
import SpectatorPanel from './SpectatorPanel';
import DebugSkillPanel from './DebugSkillPanel';
import DisconnectOverlay from './DisconnectOverlay';

const HUD: React.FC = () => {
  const isLoading = useGameStore((s) => s.isLoading);

  if (isLoading) return null;

  return (
    <div className="absolute inset-0 z-[50] pointer-events-none" style={{ pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto' }}>
        <TopBar />
        <SpectatorPanel />
        <KillFeed />
        {GAME_CONFIG.hud.visibility.showScoreboard && <Scoreboard />}
        {GAME_CONFIG.hud.visibility.showChampionInfoBar && <HealthManaBar />}
        <EmoteWheel />
        <SkillBar />
        {GAME_CONFIG.hud.visibility.showMiniMap && <MiniMap />}
        <DebugSkillPanel />
      </div>
      {/* 断线遮罩（最高层级，阻断所有交互） */}
      <DisconnectOverlay />
    </div>
  );
};

export default HUD;
