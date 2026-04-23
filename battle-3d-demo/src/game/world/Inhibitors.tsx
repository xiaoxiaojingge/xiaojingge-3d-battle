import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { INHIBITOR_ASSET_CONFIG } from '../../config/environmentConfig';
import { useGameStore } from '../../store/useGameStore';
import { TEAM_COLORS } from '../../config/mapConfig';
import FacilityAsset from './FacilityAsset';

/** 单个小水晶（兵营水晶 / Inhibitor） */
const Inhibitor: React.FC<{
  position: [number, number, number];
  team: 'blue' | 'red';
}> = ({ position, team }) => {
  /** 小水晶内核 mesh 引用，用于旋转动画。 */
  const coreRef = useRef<THREE.Mesh>(null);
  /** 小水晶光环 mesh 引用，用于旋转动画。 */
  const ringRef = useRef<THREE.Mesh>(null);

  const colors = TEAM_COLORS[team];
  const assetConfig = INHIBITOR_ASSET_CONFIG[team];
  const animationClipName = assetConfig.asset.animations?.idleClip;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    /** 内核缓慢旋转 + 呼吸缩放。 */
    if (coreRef.current) {
      coreRef.current.rotation.y += 0.01;
      const s = 1 + Math.sin(t * 2.5) * 0.05;
      coreRef.current.scale.setScalar(s);
    }

    /** 光环缓慢旋转。 */
    if (ringRef.current) {
      ringRef.current.rotation.z += 0.005;
    }
  });

  return (
    <group position={position}>
      <FacilityAsset
        modelPath={assetConfig.asset.modelPath}
        targetHeight={assetConfig.asset.targetHeight}
        modelScale={assetConfig.asset.modelScale}
        groundOffsetY={assetConfig.asset.groundOffsetY}
        rotationY={assetConfig.asset.rotationY}
        animationClipName={animationClipName}
        animationLoop
        fallbackWhenAnimationMissing
        fallback={(
          <>
            {/* 小水晶底座 */}
            <mesh position={[0, 0.3, 0]} receiveShadow>
              <cylinderGeometry args={[1.8, 2.2, 0.6, 10]} />
              <meshStandardMaterial color={0x2a3a4a} roughness={0.8} metalness={0.2} />
            </mesh>
            {/* 小水晶支柱 */}
            <mesh position={[0, 1.2, 0]}>
              <cylinderGeometry args={[0.3, 0.6, 1.8, 6]} />
              <meshStandardMaterial color={0x3a4a5a} roughness={0.7} />
            </mesh>
            {/* 小水晶内核 —— 比水晶枢纽更小的八面体 */}
            <mesh ref={coreRef} position={[0, 3.0, 0]}>
              <octahedronGeometry args={[0.9, 0]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={2.5}
                toneMapped={false}
                transparent
                opacity={0.85}
              />
            </mesh>
            {/* 小水晶环绕光环 */}
            <mesh ref={ringRef} position={[0, 3.0, 0]}>
              <torusGeometry args={[1.4, 0.04, 8, 24]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={1.2}
                toneMapped={false}
                transparent
                opacity={0.7}
              />
            </mesh>
          </>
        )}
      />

    </group>
  );
};

/** 所有小水晶（兵营水晶 / Inhibitor） */
const Inhibitors: React.FC = () => {
  const inhibitors = useGameStore((s) => s.inhibitors);

  return (
    <>
      {inhibitors.map((inh) => (
        <Inhibitor
          key={inh.id}
          position={[inh.position.x, inh.position.y, inh.position.z]}
          team={inh.team}
        />
      ))}
    </>
  );
};

export default Inhibitors;
