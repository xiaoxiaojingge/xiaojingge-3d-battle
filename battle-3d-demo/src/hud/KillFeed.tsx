import React, { useState } from 'react';

interface KillEvent {
  id: number;
  killer: string;
  killerTeam: 'blue' | 'red';
  victim: string;
  victimTeam: 'blue' | 'red';
  timestamp: number;
}

const mockKills: KillEvent[] = [
  { id: 1, killer: '亚索', killerTeam: 'blue', victim: '安妮', victimTeam: 'red', timestamp: Date.now() - 5000 },
  { id: 2, killer: '烬', killerTeam: 'red', victim: '璐璐', victimTeam: 'blue', timestamp: Date.now() - 2000 },
];

const KillFeed: React.FC = () => {
  const [events] = useState<KillEvent[]>(mockKills);

  return (
    <div className="absolute top-12 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-1 pointer-events-none">
      {events.map((e) => (
        <div
          key={e.id}
          className="flex items-center gap-2 px-3 py-1 rounded-full text-xs animate-pulse"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <span style={{ color: e.killerTeam === 'blue' ? '#64b5f6' : '#ef5350' }}>
            {e.killer}
          </span>
          <span className="text-white/30">⚔️</span>
          <span style={{ color: e.victimTeam === 'blue' ? '#64b5f6' : '#ef5350' }}>
            {e.victim}
          </span>
        </div>
      ))}
    </div>
  );
};

export default KillFeed;
