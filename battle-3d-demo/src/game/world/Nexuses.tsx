import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { NEXUS_ASSET_CONFIG } from '../../config/environmentConfig';
import { useGameStore } from '../../store/useGameStore';
import { TEAM_COLORS } from '../../config/mapConfig';
import FacilityAsset from './FacilityAsset';

/** 单个水晶枢纽 */
const Nexus: React.FC<{
  position: [number, number, number];
  team: 'blue' | 'red';
}> = ({ position, team }) => {
  const coreRef = useRef<THREE.Mesh>(null);
  const ring1Ref = useRef<THREE.Mesh>(null);
  const ring2Ref = useRef<THREE.Mesh>(null);

  const colors = TEAM_COLORS[team];
  const assetConfig = NEXUS_ASSET_CONFIG[team];
  const animationClipName = assetConfig.asset.animations?.idleClip;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    if (coreRef.current) {
      coreRef.current.rotation.y += 0.008;
      coreRef.current.rotation.x += 0.003;
      const s = 1 + Math.sin(t * 2) * 0.06;
      coreRef.current.scale.setScalar(s);
    }

    if (ring1Ref.current) {
      ring1Ref.current.rotation.z += 0.006;
    }
    if (ring2Ref.current) {
      ring2Ref.current.rotation.z -= 0.004;
      ring2Ref.current.rotation.x += 0.002;
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
            <mesh position={[0, 0.5, 0]} receiveShadow>
              <cylinderGeometry args={[2.5, 3, 1, 12]} />
              <meshStandardMaterial color={0x2a3a4a} roughness={0.8} metalness={0.2} />
            </mesh>
            <mesh position={[0, 2, 0]}>
              <cylinderGeometry args={[0.5, 1, 3, 8]} />
              <meshStandardMaterial color={0x3a4a5a} roughness={0.7} />
            </mesh>
            <mesh ref={coreRef} position={[0, 4.5, 0]}>
              <icosahedronGeometry args={[1.2, 1]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={3}
                toneMapped={false}
                transparent
                opacity={0.85}
              />
            </mesh>
            <mesh ref={ring1Ref} position={[0, 4.5, 0]}>
              <torusGeometry args={[2, 0.06, 8, 32]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={1.5}
                toneMapped={false}
              />
            </mesh>
            <mesh ref={ring2Ref} position={[0, 4.5, 0]} rotation={[Math.PI / 3, 0, 0]}>
              <torusGeometry args={[2.5, 0.04, 8, 32]} />
              <meshStandardMaterial
                color={colors.light}
                emissive={colors.primary}
                emissiveIntensity={1}
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

/** 所有水晶枢纽 */
const Nexuses: React.FC = () => {
  const nexuses = useGameStore((s) => s.nexuses);

  return (
    <>
      {nexuses.map((n) => (
        <Nexus
          key={n.id}
          position={[n.position.x, n.position.y, n.position.z]}
          team={n.team}
        />
      ))}
    </>
  );
};

export default Nexuses;
