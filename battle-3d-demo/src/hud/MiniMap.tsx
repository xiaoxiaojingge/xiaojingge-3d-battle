import React from 'react';
import { useGameStore } from '../store/useGameStore';

const MiniMap: React.FC = () => {
  const champions = useGameStore((s) => s.champions);
  const towers = useGameStore((s) => s.towers);

  const mapWidth = 160;
  const mapHeight = 80;
  const displayW = 180;
  const displayH = 90;

  const toMiniPos = (x: number, z: number) => ({
    left: ((x + mapWidth / 2) / mapWidth) * displayW,
    top: ((z + mapHeight / 2) / mapHeight) * displayH,
  });

  return (
    <div
      className="absolute bottom-4 right-4 z-[100] rounded-lg overflow-hidden"
      style={{
        width: displayW,
        height: displayH,
        background: 'rgba(0,0,0,0.6)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {/* 桥面 */}
      <div
        className="absolute"
        style={{
          left: '10%',
          right: '10%',
          top: '35%',
          bottom: '35%',
          background: 'rgba(42,58,74,0.5)',
          borderRadius: '2px',
        }}
      />

      {/* 防御塔 */}
      {towers.map((t) => {
        const pos = toMiniPos(t.position.x, t.position.z);
        return (
          <div
            key={t.id}
            className="absolute w-2 h-2 rounded-sm -translate-x-1/2 -translate-y-1/2"
            style={{
              left: pos.left,
              top: pos.top,
              background: t.team === 'blue' ? '#4488ff' : '#ff4444',
              boxShadow: `0 0 3px ${t.team === 'blue' ? '#4488ff' : '#ff4444'}`,
            }}
          />
        );
      })}

      {/* 英雄标记 */}
      {champions.map((c) => {
        const pos = toMiniPos(c.position.x, c.position.z);
        return (
          <div
            key={c.id}
            className="absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
            style={{
              left: pos.left,
              top: pos.top,
              background: c.isMe ? '#fde047' : c.team === 'blue' ? '#4488ff' : '#ff4444',
              boxShadow: c.isMe ? '0 0 4px #fde047' : 'none',
              border: c.isMe ? '1px solid #fff' : 'none',
              fontSize: '6px',
            }}
          >
          </div>
        );
      })}
    </div>
  );
};

export default MiniMap;
