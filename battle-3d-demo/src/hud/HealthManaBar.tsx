import React from 'react';
import { useGameStore } from '../store/useGameStore';
import { getHeroConfig } from '../config/heroConfig';

function formatStatusRemaining(expiresAt?: number): string {
  if (!expiresAt || !Number.isFinite(expiresAt)) {
    return '--';
  }
  const remainingMs = Math.max(0, expiresAt - Date.now());
  return `${(remainingMs / 1000).toFixed(1)}s`;
}

const HealthManaBar: React.FC = () => {
  const myChamp = useGameStore((s) => s.champions.find((champion) => champion.isMe) ?? null);
  const [, forceRefresh] = React.useState(0);

  React.useEffect(() => {
    if (!myChamp || myChamp.statusEffects.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      forceRefresh((value) => value + 1);
    }, 200);
    return () => {
      window.clearInterval(timer);
    };
  }, [myChamp?.id, myChamp?.statusEffects.length]);

  if (!myChamp) return null;

  const heroConfig = getHeroConfig(myChamp.heroId);
  const hpPercent = myChamp.maxHp > 0 ? (myChamp.hp / myChamp.maxHp) * 100 : 0;
  const mpPercent = myChamp.maxMp > 0 ? (myChamp.mp / myChamp.maxMp) * 100 : 0;

  return (
    <div className="absolute bottom-20 left-4 z-[100] flex items-end gap-3">
      {/* 头像框 */}
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl border"
        style={{
          background: 'linear-gradient(180deg, rgba(8,12,24,0.94), rgba(20,28,46,0.76))',
          borderColor: 'rgba(201,170,95,0.78)',
          boxShadow: '0 14px 36px rgba(2, 6, 23, 0.42)',
        }}
      >
        {heroConfig?.emoji || '⚔️'}
      </div>

      {/* 状态信息 */}
      <div
        className="flex min-w-[230px] flex-col gap-1 rounded-2xl border px-3 py-2"
        style={{
          borderColor: 'rgba(121, 217, 255, 0.18)',
          background: 'linear-gradient(180deg, rgba(6,10,20,0.88), rgba(15,24,40,0.78))',
          boxShadow: '0 16px 40px rgba(2,6,23,0.38)',
        }}
      >
        {/* 名称 + 等级 */}
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-game-gold text-sm font-bold tracking-wide">{myChamp.playerName}</span>
          <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-semibold text-white/75"
            style={{ borderColor: 'rgba(201,170,95,0.4)', background: 'rgba(10,16,28,0.7)' }}>
            Lv.{myChamp.level}
          </span>
        </div>

        {/* HP 条 */}
        <div className="relative h-4 rounded-md overflow-hidden border"
          style={{ background: 'rgba(0,0,0,0.58)', borderColor: 'rgba(201,170,95,0.48)' }}>
          <div
            className="h-full rounded-sm transition-all duration-300"
            style={{
              width: `${hpPercent}%`,
              background: hpPercent > 50
                ? 'linear-gradient(90deg, #1f8b47, #50df83)'
                : hpPercent > 25
                  ? 'linear-gradient(90deg, #c59222, #ffd34d)'
                  : 'linear-gradient(90deg, #b32825, #ff5b56)',
            }}
          />
          <div className="absolute left-0 right-0 top-0 h-[45%] bg-white/10" />
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white font-bold drop-shadow">
            {Math.floor(myChamp.hp)} / {myChamp.maxHp}
          </span>
        </div>

        {/* MP 条 */}
        <div className="relative h-2.5 rounded-md overflow-hidden border"
          style={{ background: 'rgba(0,0,0,0.46)', borderColor: 'rgba(123, 177, 255, 0.25)' }}>
          <div
            className="h-full rounded-sm transition-all duration-300"
            style={{
              width: `${mpPercent}%`,
              background: 'linear-gradient(90deg, #215fcb, #67b4ff)',
            }}
          />
          <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white/70 font-mono">
            {Math.floor(myChamp.mp)} / {myChamp.maxMp}
          </span>
        </div>

        {/* KDA */}
        <div className="mt-1 flex gap-2 text-[10px] text-white/45">
          <span className="rounded-full bg-white/5 px-2 py-0.5">KDA: <span className="text-white/75">{myChamp.kills}/{myChamp.deaths}/{myChamp.assists}</span></span>
          <span className="rounded-full bg-white/5 px-2 py-0.5">CS: <span className="text-white/75">0</span></span>
        </div>

        {/* Buff / Debuff 状态条 */}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {myChamp.statusEffects.length > 0 ? myChamp.statusEffects.map((status) => (
            <div
              key={status.statusInstanceId}
              className="rounded-xl border px-2 py-1 text-[10px] leading-tight"
              style={{
                borderColor: 'rgba(125, 211, 252, 0.28)',
                background: 'rgba(15, 23, 42, 0.72)',
              }}
            >
              <div className="font-semibold text-white/85">{status.statusId}</div>
              <div className="text-white/55">层数 {status.stacks} · {formatStatusRemaining(status.expiresAt)}</div>
            </div>
          )) : (
            <div className="text-[10px] text-white/35">当前无 Buff / Debuff</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default HealthManaBar;
