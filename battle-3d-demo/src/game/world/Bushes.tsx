import React from 'react';
import { BUSHES_CONFIG } from '../../config/environmentConfig';
import FacilityAsset from './FacilityAsset';
import InstancedGrass from './InstancedGrass';

const Bushes: React.FC = () => {
  return (
    <>
      {BUSHES_CONFIG.map((bush) => (
        <group key={bush.id} position={bush.position}>
          <FacilityAsset
            modelPath={bush.asset.modelPath}
            targetHeight={bush.asset.targetHeight}
            rotationY={bush.asset.rotationY}
            animationClipName={bush.asset.animations?.idleClip}
            fallbackWhenAnimationMissing
            fallback={<InstancedGrass width={bush.size[0]} depth={bush.size[2]} />}
          />
        </group>
      ))}
    </>
  );
};

export default Bushes;
