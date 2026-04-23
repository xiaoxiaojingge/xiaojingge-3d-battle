import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { ModelVisualState } from '../../types/game';
import { threejsHelper } from '../../utils/ThreejsHelper';

interface FacilityAssetProps {
  modelPath?: string;
  targetHeight: number;
  modelScale?: number;
  groundOffsetY?: number;
  /** 模型绕 Y 轴的旋转角度，单位弧度。 */
  rotationY?: number;
  animationClipName?: string;
  animationLoop?: boolean;
  fallbackWhenAnimationMissing?: boolean;
  /** 是否收敛模型脚下近地装饰底盘，避免覆盖角色阴影。 */
  suppressGroundOverlay?: boolean;
  fallback: React.ReactNode;
}

const FacilityAsset: React.FC<FacilityAssetProps> = ({
  modelPath,
  targetHeight,
  modelScale = 1,
  groundOffsetY = 0,
  rotationY = 0,
  animationClipName,
  animationLoop = true,
  fallbackWhenAnimationMissing = false,
  suppressGroundOverlay = false,
  fallback,
}) => {
  const [visualState, setVisualState] = useState<ModelVisualState>(modelPath ? 'loading' : 'fallback');
  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const activeClipRef = useRef<THREE.AnimationClip | null>(null);

  const fallbackNode = useMemo(() => fallback, [fallback]);

  useFrame((_, delta) => {
    const mixer = mixerRef.current;
    if (!mixer) return;
    /** HMR 后 mixer 的 action 可能丢失，检测并恢复。 */
    const clip = activeClipRef.current;
    if (clip) {
      const action = mixer.existingAction(clip);
      if (!action || !action.isRunning()) {
        mixer.clipAction(clip).reset().play();
      }
    }
    mixer.update(delta);
  });

  useEffect(() => {
    if (!modelPath) {
      setModelGroup(null);
      setVisualState('fallback');
      return;
    }

    let cancelled = false;
    setVisualState('loading');
    setModelGroup(null);
    mixerRef.current = null;
    activeClipRef.current = null;

    const loadModel = async () => {
      try {
        const gltf = await threejsHelper.loadGLTF(modelPath);
        if (cancelled) return;

        const clips = threejsHelper.getAnimationClips(gltf);
        const resolvedClip = animationClipName ? threejsHelper.findAnimationClip(clips, animationClipName) : undefined;
        if (animationClipName && !resolvedClip && fallbackWhenAnimationMissing) {
          setModelGroup(null);
          setVisualState('fallback');
          return;
        }

        const wrapper = threejsHelper.prepareModel(gltf, targetHeight, modelScale, groundOffsetY, suppressGroundOverlay);
        if (resolvedClip) {
          const animatedRoot = wrapper.children[0] || wrapper;
          const mixer = new THREE.AnimationMixer(animatedRoot);
          const action = mixer.clipAction(resolvedClip);
          action.loop = animationLoop ? THREE.LoopRepeat : THREE.LoopOnce;
          action.clampWhenFinished = !animationLoop;
          action.reset().play();
          mixerRef.current = mixer;
          activeClipRef.current = resolvedClip;
        }

        setModelGroup(wrapper);
        setVisualState('ready');
      } catch (_error) {
        if (cancelled) return;
        setModelGroup(null);
        setVisualState('fallback');
      }
    };

    loadModel();

    return () => {
      cancelled = true;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      activeClipRef.current = null;
    };
  }, [animationClipName, animationLoop, fallbackWhenAnimationMissing, groundOffsetY, modelPath, modelScale, suppressGroundOverlay, targetHeight]);

  if (visualState === 'ready' && modelGroup) {
    return (
      <group rotation-y={rotationY}>
        <primitive object={modelGroup} />
      </group>
    );
  }

  return (
    <group rotation-y={rotationY}>
      {fallbackNode}
    </group>
  );
};

export default FacilityAsset;
