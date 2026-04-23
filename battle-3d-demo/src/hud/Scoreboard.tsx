import React, { useMemo } from 'react';
import { GAME_CONFIG } from '../config/gameConfig';
import { useGameStore } from '../store/useGameStore';
import { getHeroConfig } from '../config/heroConfig';
import type { Team } from '../types/game';

const Scoreboard: React.FC = () => {
  const champions = useGameStore((s) => s.champions);

  const blueTeam = useMemo(() => champions.filter((c) => c.team === 'blue'), [champions]);
  const redTeam = useMemo(() => champions.filter((c) => c.team === 'red'), [champions]);

  return (
    <>
      {/* 蓝队（左侧） */}
      <TeamScoreboard team="blue" members={blueTeam} side="left" />
      {/* 红队（右侧） */}
      <TeamScoreboard team="red" members={redTeam} side="right" />
    </>
  );
};

const TeamScoreboard: React.FC<{
  team: Team;
  members: ReturnType<typeof useGameStore.getState>['champions'];
  side: 'left' | 'right';
}> = ({ team, members, side }) => {
  const isLeft = side === 'left';
  const scoreboardConfig = GAME_CONFIG.hud.scoreboard;

  return (
    <div
      className="absolute z-[100] flex flex-col"
      style={{
        top: scoreboardConfig.topOffsetPx,
        left: isLeft ? scoreboardConfig.sideOffsetPx : undefined,
        right: isLeft ? undefined : scoreboardConfig.sideOffsetPx,
        gap: scoreboardConfig.rowGapPx,
      }}
    >
      {members.map((m) => {
        const hero = getHeroConfig(m.heroId);
        const hpPercent = m.maxHp > 0 ? (m.hp / m.maxHp) * 100 : 0;
        return (
          <div
            key={m.id}
            className={`flex items-center gap-2 py-1 px-2 rounded-xl border ${m.isMe ? 'ring-1 ring-game-gold/50' : ''}`}
            style={{
              background: isLeft
                ? 'linear-gradient(90deg, rgba(7,16,29,0.86), rgba(14,36,58,0.72))'
                : 'linear-gradient(270deg, rgba(29,10,17,0.86), rgba(54,18,28,0.72))',
              borderColor: isLeft ? 'rgba(100,181,246,0.28)' : 'rgba(239,83,80,0.28)',
              boxShadow: '0 10px 28px rgba(2,6,23,0.18)',
            }}
          >
            {/* 头像 */}
            <div className="w-6 h-6 rounded-lg text-xs flex items-center justify-center border"
              style={{
                background: m.isDead ? '#333' : 'rgba(255,255,255,0.08)',
                borderColor: m.isMe ? 'rgba(253, 224, 71, 0.45)' : 'rgba(255,255,255,0.08)',
              }}>
              {hero?.emoji || '?'}
            </div>

            {/* 血条 */}
            <div className="w-14 h-2 rounded-sm overflow-hidden border" style={{ background: 'rgba(0,0,0,0.45)', borderColor: 'rgba(255,255,255,0.06)' }}>
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${hpPercent}%`,
                  background: team === 'blue'
                    ? 'linear-gradient(90deg, #2f9f5d, #62df92)'
                    : 'linear-gradient(90deg, #bf3a35, #ff7361)',
                }}
              />
            </div>

            {/* 等级 */}
            <span
              className="font-semibold text-white/55"
              style={{
                minWidth: scoreboardConfig.levelMinWidthPx,
                fontSize: scoreboardConfig.levelFontSize,
              }}
            >
              {m.level}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default Scoreboard;
