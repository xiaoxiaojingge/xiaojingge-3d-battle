import React, { useRef, useMemo, useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AnimationClipRequest, ChampionState, HeroActionSlot, ModelVisualState, Team } from '../../types/game';
import { GAME_CONFIG } from '../../config/gameConfig';
import { EMOTE_MAP } from '../../config/emoteConfig';
import { getHeroAnimationConfig, getHeroConfig, getHeroOverheadConfig, getHeroVoiceConfig } from '../../config/heroConfig';
import { RENDER_CONFIG } from '../../config/renderConfig';
import { useGameStore } from '../../store/useGameStore';
import { threejsHelper } from '../../utils/ThreejsHelper';
import { getHeroModelPath } from '../../utils/heroModel';
import { AnimationController } from './AnimationController';
import { createChampionHudTexture, createEmoteTexture } from './championOverheadTexture';

interface ChampionProps {
  championId: string;
}

/** 创建血条 Canvas 纹理（纯 GPU，不走 DOM） */
function createHealthBarTexture(
  hp: number,
  maxHp: number,
  mp: number,
  maxMp: number,
  team: 'blue' | 'red',
  name: string,
  level: number,
  isMe: boolean,
): THREE.CanvasTexture {
  return createChampionHudTexture(hp, maxHp, mp, maxMp, team, name, level, isMe);
}

function pickRandomItem<T>(items?: T[]): T | undefined {
  if (!items || items.length === 0) {
    return undefined;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function resolveActionSlotFromRequest(
  request: AnimationClipRequest | null,
  actionClips?: Partial<Record<HeroActionSlot, string>>,
): HeroActionSlot | undefined {
  if (!request) {
    return undefined;
  }

  if (request.actionSlot) {
    return request.actionSlot;
  }

  const clipName = request.clipName.toLowerCase();
  return (Object.entries(actionClips ?? {}) as Array<[HeroActionSlot, string | undefined]>).find(([, configuredClip]) => {
    if (!configuredClip) {
      return false;
    }

    const lowerConfiguredClip = configuredClip.toLowerCase();
    return lowerConfiguredClip === clipName || lowerConfiguredClip.includes(clipName) || clipName.includes(lowerConfiguredClip);
  })?.[0];
}

/** 单个英雄组件（自动尝试加载glTF模型，降级为程序化几何体） */
const Champion: React.FC<ChampionProps> = ({ championId }) => {
  const state = useGameStore((s): ChampionState => s.champions.find((champion) => champion.id === championId) as ChampionState);
  const groupRef = useRef<THREE.Group>(null);
  const [visualState, setVisualState] = useState<ModelVisualState>('idle');
  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const animControllerRef = useRef<AnimationController | null>(null);
  const rootMotionNodesRef = useRef<Array<{ node: THREE.Object3D; x: number; z: number }>>([]);
  const hpBarRef = useRef<THREE.Sprite>(null);
  const emoteSpriteRef = useRef<THREE.Sprite>(null);
  const lastClipRequestKeyRef = useRef<string | null>(null);
  const lastAnimationVoiceNonceRef = useRef<number | null>(null);
  const lastVoiceCommandNonceRef = useRef<number | null>(null);
  const activeVoiceRef = useRef<HTMLAudioElement | null>(null);
  const activeVoiceSlotRef = useRef<HeroActionSlot | 'idle' | null>(null);
  /** 复用 Audio 对象池，避免反复 new Audio() 导致浏览器资源耗尽 */
  const audioPoolRef = useRef<HTMLAudioElement[]>([]);
  const audioPoolNextRef = useRef(0);
  /** 语音播放冷却时间戳，用于去重同帧的动画触发与显式语音请求 */
  const voicePlayedAtRef = useRef(0);
  const renderPositionRef = useRef(new THREE.Vector3());
  const targetPositionRef = useRef(new THREE.Vector3());
  const renderRotationRef = useRef(0);
  /** 记录上一次 state.position 引用，用于检测快照更新。 */
  const lastStatePositionRef = useRef<THREE.Vector3 | null>(null);
  /** 外推用的临时向量，避免每帧 new。 */
  const extrapolationDirRef = useRef(new THREE.Vector3());

  const heroConfig = useMemo(() => getHeroConfig(state.heroId), [state.heroId]);
  const heroAnimationConfig = useMemo(() => getHeroAnimationConfig(state.heroId), [state.heroId]);
  const heroVoiceConfig = useMemo(() => getHeroVoiceConfig(state.heroId), [state.heroId]);
  const heroOverheadConfig = useMemo(() => getHeroOverheadConfig(state.heroId), [state.heroId]);
  const modelPath = useMemo(
    () => getHeroModelPath(state.heroId, {
      skin: state.skin,
      overridePath: state.skin ? undefined : heroConfig?.modelPath,
    }),
    [heroConfig?.modelPath, state.heroId, state.skin],
  );
  const activeEmote = useGameStore((s) => {
    for (let i = s.activeEmotes.length - 1; i >= 0; i -= 1) {
      const item = s.activeEmotes[i];
      if (item.championId === championId) {
        return item;
      }
    }
    return null;
  });
  const overheadConfig = useMemo(() => {
    const base = GAME_CONFIG.hud.overhead;
    return {
      ...base,
      ...heroOverheadConfig,
      hpSpriteScale: heroOverheadConfig?.hpSpriteScale ?? base.hpSpriteScale,
      emoteSpriteScale: heroOverheadConfig?.emoteSpriteScale ?? base.emoteSpriteScale,
    };
  }, [heroOverheadConfig]);

  // 血条纹理
  const hpTexture = useMemo(() => {
    return createHealthBarTexture(
      state.hp, state.maxHp, state.mp, state.maxMp,
      state.team, state.playerName, state.level, state.isMe,
    );
  }, [state.hp, state.maxHp, state.mp, state.maxMp, state.team, state.playerName, state.level, state.isMe]);

  const emoteTexture = useMemo(() => {
    if (!activeEmote) {
      return null;
    }

    const emote = EMOTE_MAP[activeEmote.emoteId];
    return createEmoteTexture(emote);
  }, [activeEmote]);

  useEffect(() => {
    return () => {
      hpTexture.dispose();
    };
  }, [hpTexture]);

  useEffect(() => {
    return () => {
      emoteTexture?.dispose();
    };
  }, [emoteTexture]);

  useEffect(() => {
    targetPositionRef.current.copy(state.position);
    if (!groupRef.current) {
      renderPositionRef.current.copy(state.position);
      renderRotationRef.current = state.rotation;
      return;
    }

    if (!GAME_CONFIG.multiplayer.enabled) {
      renderPositionRef.current.copy(state.position);
      renderRotationRef.current = state.rotation;
      groupRef.current.position.copy(state.position);
      groupRef.current.rotation.y = state.rotation;
      return;
    }

    if (renderPositionRef.current.lengthSq() === 0 && groupRef.current.position.lengthSq() === 0) {
      renderPositionRef.current.copy(state.position);
      renderRotationRef.current = state.rotation;
      groupRef.current.position.copy(state.position);
      groupRef.current.rotation.y = state.rotation;
    }
  }, [state.position, state.rotation]);

  useEffect(() => {
    return () => {
      /* 组件卸载时释放当前正在播放的语音 */
      if (activeVoiceRef.current) {
        activeVoiceRef.current.pause();
        activeVoiceRef.current.onended = null;
        activeVoiceRef.current.onerror = null;
        activeVoiceRef.current = null;
        activeVoiceSlotRef.current = null;
      }
      /* 销毁对象池中所有 Audio 实例的媒体缓冲区 */
      audioPoolRef.current.forEach((audio) => {
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
        audio.removeAttribute('src');
        audio.load();
      });
      audioPoolRef.current = [];
      audioPoolNextRef.current = 0;
    };
  }, []);

  const stopActiveVoice = React.useCallback(() => {
    if (!activeVoiceRef.current) {
      return;
    }

    const audio = activeVoiceRef.current;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    /* 清空 src 并调用 load() 释放浏览器内部的媒体解码缓冲区，避免内存持续增长 */
    audio.removeAttribute('src');
    audio.load();
    activeVoiceRef.current = null;
    activeVoiceSlotRef.current = null;
  }, []);

  const playAudioUrl = React.useCallback((voiceUrl: string, volume: number, slot: HeroActionSlot | 'idle' | null) => {
    stopActiveVoice();

    /* ── 从对象池取出或懒创建 Audio 实例（上限 3 个，循环复用） ── */
    const POOL_SIZE = 3;
    if (audioPoolRef.current.length < POOL_SIZE) {
      const newAudio = new Audio();
      newAudio.preload = 'auto';
      newAudio.crossOrigin = 'anonymous';
      audioPoolRef.current.push(newAudio);
    }
    const idx = audioPoolNextRef.current % audioPoolRef.current.length;
    audioPoolNextRef.current = idx + 1;
    const audio = audioPoolRef.current[idx];

    /* 确保复用的实例处于干净状态 */
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.volume = THREE.MathUtils.clamp(volume, 0, 1);
    audio.src = voiceUrl;

    activeVoiceRef.current = audio;
    activeVoiceSlotRef.current = slot;
    voicePlayedAtRef.current = Date.now();

    const finalize = () => {
      if (activeVoiceRef.current === audio) {
        activeVoiceRef.current = null;
        activeVoiceSlotRef.current = null;
      }
    };

    audio.onended = finalize;
    audio.onerror = finalize;
    void audio.play().catch(() => {
      finalize();
    });

    return true;
  }, [stopActiveVoice]);

  const playVoice = React.useCallback((slot: HeroActionSlot | 'idle') => {
    const candidates = heroVoiceConfig?.[slot];
    const voiceUrl = pickRandomItem(candidates);
    if (!voiceUrl) {
      return false;
    }

    return playAudioUrl(voiceUrl, heroVoiceConfig?.volume ?? 1, slot);
  }, [heroVoiceConfig, playAudioUrl]);

  const playVoiceByRequest = React.useCallback((request: ChampionState['lastVoiceRequest']) => {
    if (!request) {
      return;
    }

    if (lastVoiceCommandNonceRef.current === request.nonce) {
      return;
    }

    lastVoiceCommandNonceRef.current = request.nonce;

    if (request.slot === 'customWheel') {
      const voiceUrl = request.voiceUrl;
      if (!voiceUrl) {
        return;
      }

      playAudioUrl(voiceUrl, request.volume ?? heroVoiceConfig?.volume ?? 1, null);
      return;
    }

    playVoice(request.slot);
  }, [heroVoiceConfig?.volume, playAudioUrl, playVoice]);

  useEffect(() => {
    const actionSlot = resolveActionSlotFromRequest(state.animationClipRequest, heroAnimationConfig?.actionClips);
    const nonce = state.animationClipRequest?.nonce ?? null;
    if (!actionSlot || nonce === null || lastAnimationVoiceNonceRef.current === nonce) {
      return;
    }

    lastAnimationVoiceNonceRef.current = nonce;

    /*
     * 去重：若同一渲染帧中还存在未消费的显式语音请求（lastVoiceRequest），
     * 则跳过动画触发的语音，让显式请求优先播放，避免同一次施法产生两次语音。
     */
    if (state.lastVoiceRequest && lastVoiceCommandNonceRef.current !== state.lastVoiceRequest.nonce) {
      return;
    }

    playVoice(actionSlot);
  }, [heroAnimationConfig?.actionClips, playVoice, state.animationClipRequest, state.lastVoiceRequest]);

  useEffect(() => {
    if (!state.lastVoiceRequest) {
      return;
    }
    playVoiceByRequest(state.lastVoiceRequest);
  }, [playVoiceByRequest, state.lastVoiceRequest]);

  useEffect(() => {
    if (state.isDead) {
      stopActiveVoice();
    }
  }, [state.isDead, stopActiveVoice]);

  // 尝试加载 glTF 模型
  useEffect(() => {
    setVisualState('loading');
    setModelGroup(null);
    animControllerRef.current?.dispose();
    animControllerRef.current = null;
    rootMotionNodesRef.current = [];

    let cancelled = false;
    const loadModel = async () => {
      try {
        const gltf = await threejsHelper.loadGLTF(modelPath);
        if (cancelled) return;

        const wrapper = threejsHelper.prepareModel(
          gltf,
          RENDER_CONFIG.heroTargetHeight,
          heroConfig?.asset?.modelScale ?? 1,
          heroConfig?.asset?.groundOffsetY ?? 0,
        );

        const clips = threejsHelper.getAnimationClips(gltf);
        if (clips.length > 0) {
          const clonedScene = wrapper.children[0] || wrapper;
          animControllerRef.current = new AnimationController(clonedScene, clips, heroAnimationConfig);
          const rootMotionNodes: Array<{ node: THREE.Object3D; x: number; z: number }> = [
            { node: clonedScene, x: clonedScene.position.x, z: clonedScene.position.z },
          ];
          clonedScene.traverse((child) => {
            if (child === clonedScene) return;
            if (!/(armature|root|hips)/i.test(child.name)) return;
            rootMotionNodes.push({ node: child, x: child.position.x, z: child.position.z });
          });
          rootMotionNodesRef.current = rootMotionNodes;
          if (import.meta.env.DEV && state.isMe) {
            // console.log(`[Champion] ${state.heroId} available clips:`, animControllerRef.current.getAvailableClipNames());
          }
        }

        setModelGroup(wrapper);
        setVisualState('ready');
      } catch (err) {
        console.warn(`[Champion] Model load failed for ${state.heroId}, using fallback.`, err);
        if (cancelled) return;
        setModelGroup(null);
        setVisualState('fallback');
      }
    };

    loadModel();
    return () => {
      cancelled = true;
      animControllerRef.current?.dispose();
      animControllerRef.current = null;
      rootMotionNodesRef.current = [];
    };
  }, [heroAnimationConfig, heroConfig?.asset?.groundOffsetY, heroConfig?.asset?.modelScale, modelPath, state.heroId]);

  // 更新动画
  useFrame((_, delta) => {
    if (groupRef.current) {
      if (GAME_CONFIG.multiplayer.enabled) {
        /* ── 联机模式：客户端外推 + 指数衰减 lerp ──
         * state.position 仅在快照消费时跳变（约 12fps / 84ms 间隔），
         * 直接 lerp 追踪会在快照间隔内静止等待，导致视觉顿挫。
         *
         * 解决：当英雄正在移动（moveTarget 非 null）时，利用 moveTarget 方向
         * 和英雄速度在快照间隔内**外推** targetPosition，使 lerp 追的目标
         * 从"阶梯信号"变为"连续平滑信号"。
         *
         * 快照到来时（state.position 引用变化）重新对齐到服务端权威位置。 */

        const positionChanged = state.position !== lastStatePositionRef.current;
        if (positionChanged) {
          /* 新快照到达，重新对齐到服务端权威位置。
           * 如果当前渲染位置与服务端权威位置差距过大（>SNAP_THRESHOLD），
           * 直接跳转到服务端位置避免视觉瞬移/滑行。 */
          const SNAP_THRESHOLD_SQ = 9; // 3 单位的平方
          const dx = state.position.x - renderPositionRef.current.x;
          const dz = state.position.z - renderPositionRef.current.z;
          const distSq = dx * dx + dz * dz;
          targetPositionRef.current.copy(state.position);
          if (distSq > SNAP_THRESHOLD_SQ) {
            /* 差异过大：直接 snap 渲染位置，跳过 lerp 过渡 */
            renderPositionRef.current.copy(state.position);
          }
          lastStatePositionRef.current = state.position;
        }

        if (state.moveTarget && !state.isDead) {
          /* 英雄正在移动：向 moveTarget 方向外推 */
          const dir = extrapolationDirRef.current;
          dir.copy(state.moveTarget).sub(targetPositionRef.current);
          dir.y = 0;
          const remainDist = dir.length();
          if (remainDist > 0.01) {
            dir.divideScalar(remainDist); // normalize
            const moveSpeed = (heroConfig?.moveSpeed ?? 300) / 100; // 世界单位/秒
            const step = moveSpeed * delta;
            /* 不超过到目标的剩余距离 */
            targetPositionRef.current.addScaledVector(dir, Math.min(step, remainDist));
          }
        }

        const smoothingFactor = state.isMe
          ? GAME_CONFIG.multiplayer.positionSmoothing * 2.5
          : GAME_CONFIG.multiplayer.positionSmoothing * 2.0;
        renderPositionRef.current.lerp(targetPositionRef.current, 1 - Math.exp(-smoothingFactor * delta));
        groupRef.current.position.copy(renderPositionRef.current);

        /* ── 旋转外推：向 moveTarget 或施法方向平滑旋转 ── */
        let targetRotation = state.rotation;
        const now = Date.now();
        const isCastingLocked = state.movementLockedUntil > now;
        if (isCastingLocked) {
          /* 施法锁定期间：保持 store 中设定的施法朝向（由 setChampionFacingRotation 更新），
           * 不让 moveTarget 方向覆盖，确保英雄面朝施法方向播放动画。 */
          targetRotation = state.rotation;
        } else if (state.moveTarget && !state.isDead) {
          const dx = state.moveTarget.x - renderPositionRef.current.x;
          const dz = state.moveTarget.z - renderPositionRef.current.z;
          if (dx * dx + dz * dz > 0.001) {
            targetRotation = Math.atan2(dx, dz);
          }
        }

        const rotSmoothingFactor = state.isMe
          ? GAME_CONFIG.multiplayer.rotationSmoothing * 2.5
          : GAME_CONFIG.multiplayer.rotationSmoothing * 2.0;
        const rotationDelta = ((targetRotation - renderRotationRef.current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        renderRotationRef.current += rotationDelta * (1 - Math.exp(-rotSmoothingFactor * delta));
        groupRef.current.rotation.y = renderRotationRef.current;
      } else {
        groupRef.current.position.copy(state.position);
        groupRef.current.rotation.y = state.rotation;
      }
    }

    if (animControllerRef.current) {
      const clipRequest = state.animationClipRequest;
      const clipRequestKey = clipRequest
        ? `${clipRequest.clipName}|${clipRequest.loop ? 'loop' : 'once'}|${clipRequest.reset === false ? 'keep' : 'reset'}|${clipRequest.nonce ?? 'stable'}`
        : null;

      if (clipRequest && clipRequestKey !== lastClipRequestKeyRef.current) {
        const played = animControllerRef.current.playClip(clipRequest as AnimationClipRequest);
        if (played) {
          lastClipRequestKeyRef.current = clipRequestKey;
        }
      }

      if (!clipRequest) {
        lastClipRequestKeyRef.current = null;
      }

      animControllerRef.current.setState(state.animationState);
      animControllerRef.current.update(delta);

      rootMotionNodesRef.current.forEach(({ node, x, z }) => {
        if (node.position.x !== x || node.position.z !== z) {
          node.position.x = x;
          node.position.z = z;
        }
      });
    }

    /* 每帧同步血条 sprite 的 Y 位置与缩放，确保配置变更能动态生效 */
    if (hpBarRef.current) {
      hpBarRef.current.position.y = overheadConfig.hpSpritePositionY;
      const hpScale = overheadConfig.hpSpriteScale;
      hpBarRef.current.scale.set(hpScale[0], hpScale[1], hpScale[2]);
    }

    /* 每帧同步表情 sprite 的 Y 位置与缩放，缩放基于配置值 × 弹跳动画系数 */
    if (emoteSpriteRef.current) {
      if (!activeEmote) {
        emoteSpriteRef.current.visible = false;
      } else {
        const elapsedMs = Date.now() - activeEmote.createdAt;
        const life = THREE.MathUtils.clamp(elapsedMs / Math.max(1, activeEmote.expiresAt - activeEmote.createdAt), 0, 1);
        emoteSpriteRef.current.visible = true;
        emoteSpriteRef.current.position.y = overheadConfig.emoteSpritePositionY + life * 0.55;
        /* 弹跳动画系数：以配置的 emoteSpriteScale 为基准进行缩放 */
        const bounce = 1.18 + Math.sin(life * Math.PI) * 0.14;
        const emoteScale = overheadConfig.emoteSpriteScale;
        emoteSpriteRef.current.scale.set(emoteScale[0] * bounce, emoteScale[1] * bounce, emoteScale[2]);
        const material = emoteSpriteRef.current.material;
        if (material instanceof THREE.SpriteMaterial) {
          material.opacity = 1 - Math.max(0, life - 0.72) / 0.28;
        }
      }
    }
  });

  return (
    <group
      ref={groupRef}
      position={[state.position.x, state.position.y, state.position.z]}
      rotation={[0, state.rotation, 0]}
      userData={{
        entityType: 'champion',
        championId: state.id,
        team: state.team,
        isDead: state.isDead,
        isMe: state.isMe,
      }}
    >
      {visualState === 'ready' && modelGroup ? (
        <primitive object={modelGroup} />
      ) : (
        <ProceduralChampion
          heroId={state.heroId}
          team={state.team}
          isMe={state.isMe}
          isDead={state.isDead}
        />
      )}

      {/* 头顶血条（Sprite，纯GPU渲染，不卡） */}
      <sprite ref={hpBarRef} position={[0, overheadConfig.hpSpritePositionY, 0]} scale={overheadConfig.hpSpriteScale}>
        <spriteMaterial map={hpTexture} transparent depthTest depthWrite={false} />
      </sprite>

      {activeEmote && emoteTexture && (
        <sprite ref={emoteSpriteRef} position={[0, overheadConfig.emoteSpritePositionY, 0]} scale={overheadConfig.emoteSpriteScale}>
          <spriteMaterial map={emoteTexture} transparent depthTest depthWrite={false} />
        </sprite>
      )}
    </group>
  );
};

/** 程序化英雄模型（降级方案） */
const ProceduralChampion: React.FC<{
  heroId: string;
  team: Team;
  isMe: boolean;
  isDead: boolean;
}> = React.memo(({ heroId, team, isMe, isDead }) => {
  const bodyRef = useRef<THREE.Group>(null);
  const heroConfig = getHeroConfig(heroId);
  const bodyColor = heroConfig?.bodyColor || (team === 'blue' ? 0x4488ff : 0xff4444);
  const accentColor = heroConfig?.accentColor || 0xffffff;
  const crestColor = isMe ? 0xfde047 : accentColor;
  const motionProfile = useMemo(() => {
    const seed = Array.from(heroId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return {
      speed: 1.45 + (seed % 5) * 0.05,
      offset: seed * 0.11,
    };
  }, [heroId]);

  useFrame(({ clock }) => {
    if (!bodyRef.current || isDead) return;
    const t = clock.getElapsedTime();

    // 呼吸动画
    bodyRef.current.position.y = Math.sin(t * motionProfile.speed + motionProfile.offset) * 0.12;
    // 轻微摇摆
    bodyRef.current.rotation.y = Math.sin(t * motionProfile.speed * 0.7 + motionProfile.offset) * 0.08;
  });

  return (
    <group ref={bodyRef}>
      {/* 身体（胶囊体） */}
      <mesh position={[0, 1.08, 0]} castShadow>
        <capsuleGeometry args={[0.34, 1.12, 8, 16]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh position={[0, 1.1, 0.16]} castShadow>
        <boxGeometry args={[0.7, 1.15, 0.32]} />
        <meshStandardMaterial color={accentColor} roughness={0.38} metalness={0.48} />
      </mesh>
      <mesh position={[0, 0.55, 0.05]} castShadow>
        <cylinderGeometry args={[0.25, 0.38, 0.34, 6]} />
        <meshStandardMaterial color={crestColor} roughness={0.45} metalness={0.4} />
      </mesh>
      <mesh position={[-0.26, 0.25, 0]} castShadow>
        <capsuleGeometry args={[0.11, 0.52, 4, 8]} />
        <meshStandardMaterial color={0x35404d} roughness={0.7} metalness={0.18} />
      </mesh>
      <mesh position={[0.26, 0.25, 0]} castShadow>
        <capsuleGeometry args={[0.11, 0.52, 4, 8]} />
        <meshStandardMaterial color={0x35404d} roughness={0.7} metalness={0.18} />
      </mesh>

      {/* 头部 */}
      <mesh position={[0, 2.15, 0]} castShadow>
        <sphereGeometry args={[0.31, 14, 14]} />
        <meshStandardMaterial color={0xeeddcc} roughness={0.5} />
      </mesh>
      <mesh position={[0, 2.36, 0]} castShadow>
        <coneGeometry args={[0.3, 0.36, 6]} />
        <meshStandardMaterial color={crestColor} roughness={0.42} metalness={0.48} />
      </mesh>
      <mesh position={[0, 2.15, 0.22]} castShadow>
        <boxGeometry args={[0.44, 0.24, 0.18]} />
        <meshStandardMaterial color={accentColor} roughness={0.42} metalness={0.46} />
      </mesh>

      {/* 肩甲（左） */}
      <mesh position={[-0.47, 1.56, 0.02]} castShadow>
        <sphereGeometry args={[0.24, 12, 12]} />
        <meshStandardMaterial color={accentColor} roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[-0.64, 1.03, 0]} rotation={[0, 0, 0.3]} castShadow>
        <capsuleGeometry args={[0.1, 0.62, 4, 8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.62} metalness={0.18} />
      </mesh>

      {/* 肩甲（右） */}
      <mesh position={[0.47, 1.56, 0.02]} castShadow>
        <sphereGeometry args={[0.24, 12, 12]} />
        <meshStandardMaterial color={accentColor} roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0.66, 1.02, 0.03]} rotation={[0.1, 0, -0.24]} castShadow>
        <capsuleGeometry args={[0.1, 0.72, 4, 8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.62} metalness={0.18} />
      </mesh>
      <mesh position={[0.9, 1.05, 0.16]} rotation={[0.3, 0.15, -0.28]} castShadow>
        <boxGeometry args={[0.12, 0.88, 0.12]} />
        <meshStandardMaterial color={crestColor} roughness={0.28} metalness={0.86} />
      </mesh>
      <mesh position={[1.03, 1.38, 0.18]} rotation={[0.26, 0.15, -0.28]} castShadow>
        <coneGeometry args={[0.16, 0.46, 5]} />
        <meshStandardMaterial color={0xdfe8f3} roughness={0.18} metalness={0.9} />
      </mesh>

      {/* 英雄标识（Emoji对应的简单形状） */}
      <mesh position={[0, 2.7, 0]}>
        <sphereGeometry args={[0.12, 8, 8]} />
        <meshStandardMaterial
          color={crestColor}
          emissive={crestColor}
          emissiveIntensity={1.5}
          toneMapped={false}
        />
      </mesh>

      {/* 脚底阴影圆 */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.52, 16]} />
        <meshBasicMaterial color={0x000000} transparent opacity={0.16} />
      </mesh>
    </group>
  );
});

export default React.memo(Champion);
