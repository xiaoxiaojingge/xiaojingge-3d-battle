import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TOWER_ASSET_CONFIG } from '../../config/environmentConfig';
import { GAME_CONFIG } from '../../config/gameConfig';
import { useGameStore } from '../../store/useGameStore';
import { TEAM_COLORS } from '../../config/mapConfig';
import FacilityAsset from './FacilityAsset';

/** 根据血量百分比和配置阈值计算当前动画状态。 */
function getTowerHealthState(hp: number, maxHp: number, isDestroyed: boolean): 'idle' | 'damaged' | 'critical' | 'death' {
  if (isDestroyed || hp <= 0) return 'death';
  const ratio = hp / maxHp;
  const { criticalThreshold, damagedThreshold } = GAME_CONFIG.environment.towers;
  if (ratio <= criticalThreshold) return 'critical';
  if (ratio <= damagedThreshold) return 'damaged';
  return 'idle';
}

/** 单个防御塔 */
const Tower: React.FC<{
  position: [number, number, number];
  team: 'blue' | 'red';
  type: 'outer' | 'inner' | 'nexusGuard';
  hp: number;
  maxHp: number;
  isDestroyed: boolean;
}> = ({ position, team, type, hp, maxHp, isDestroyed }) => {
  const crystalRef = useRef<THREE.Mesh>(null);

  const colors = TEAM_COLORS[team];
  const assetConfig = TOWER_ASSET_CONFIG[`${team}_${type}`];

  /** 根据血量状态选择对应动画片段，依次降级。 */
  const healthState = useMemo(() => getTowerHealthState(hp, maxHp, isDestroyed), [hp, maxHp, isDestroyed]);
  const animationClipName = useMemo(() => {
    const anims = assetConfig.asset.animations;
    if (!anims) return undefined;
    switch (healthState) {
      case 'death': return anims.deathClip;
      case 'critical': return anims.criticalClip ?? anims.damagedClip ?? anims.idleClip;
      case 'damaged': return anims.damagedClip ?? anims.idleClip;
      default: return anims.idleClip;
    }
  }, [assetConfig.asset.animations, healthState]);
  const height = type === 'inner' ? 6 : type === 'nexusGuard' ? 5.4 : 5;
  const baseRadius = type === 'nexusGuard' ? 1.05 : 1.2;
  const topRadius = type === 'nexusGuard' ? 0.65 : 0.8;
  const crystalSize = type === 'nexusGuard' ? 0.66 : 0.8;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (crystalRef.current) {
      crystalRef.current.rotation.y += 0.01;
      const s = 1 + Math.sin(t * 2) * 0.08;
      crystalRef.current.scale.setScalar(s);
    }
  });

  return (
    <group position={position}>
      <FacilityAsset
        modelPath={assetConfig.asset.modelPath}
        targetHeight={assetConfig.asset.targetHeight}
        modelScale={assetConfig.asset.modelScale}
        groundOffsetY={assetConfig.asset.groundOffsetY}
        animationClipName={animationClipName}
        rotationY={assetConfig.asset.rotationY}
        animationLoop={healthState !== 'death'}
        fallbackWhenAnimationMissing
        suppressGroundOverlay
        fallback={(
          <>
            <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[baseRadius, baseRadius * 1.25, 0.6, 8]} />
              <meshStandardMaterial color={0x3a4a5a} roughness={0.8} metalness={0.2} />
            </mesh>
            <mesh position={[0, height / 2 + 0.6, 0]} castShadow>
              <cylinderGeometry args={[0.4, topRadius, height, 8]} />
              <meshStandardMaterial color={0x4a5a6a} roughness={0.7} metalness={0.3} />
            </mesh>
            <mesh ref={crystalRef} position={[0, height + 1.2, 0]}>
              <octahedronGeometry args={[crystalSize]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={2}
                toneMapped={false}
                transparent
                opacity={0.9}
              />
            </mesh>
          </>
        )}
      />

    </group>
  );
};

/** 所有防御塔 */
const Towers: React.FC = () => {
  const towers = useGameStore((s) => s.towers);

  return (
    <>
      {towers.map((t) => (
        <Tower
          key={t.id}
          position={[t.position.x, t.position.y, t.position.z]}
          team={t.team}
          type={t.type}
          hp={t.hp}
          maxHp={t.maxHp}
          isDestroyed={t.isDestroyed}
        />
      ))}
    </>
  );
};

export default Towers;
