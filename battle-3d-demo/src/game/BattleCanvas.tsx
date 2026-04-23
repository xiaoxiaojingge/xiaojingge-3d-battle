import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import BattleScene from './scene/BattleScene';
import { useGameStore } from '../store/useGameStore';
import LoadingScreen from './LoadingScreen';
import { usePreloadSceneModels } from './hooks/usePreloadSceneModels';
import { RENDER_CONFIG } from '../config/renderConfig';
import { CAMERA_CONFIG } from '../config/cameraConfig';

const BattleCanvas: React.FC = () => {
  const isLoading = useGameStore((s) => s.isLoading);
  usePreloadSceneModels();

  return (
    <>
      {isLoading && <LoadingScreen />}
      <Canvas
        shadows={RENDER_CONFIG.enableShadows}
        dpr={RENDER_CONFIG.dpr}
        camera={{
          fov: CAMERA_CONFIG.fov,
          near: CAMERA_CONFIG.near,
          far: CAMERA_CONFIG.far,
          position: [...CAMERA_CONFIG.baseOffset],
        }}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: RENDER_CONFIG.toneMappingExposure,
        }}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
      >
        <Suspense fallback={null}>
          <BattleScene />
        </Suspense>
      </Canvas>
    </>
  );
};

export default BattleCanvas;
