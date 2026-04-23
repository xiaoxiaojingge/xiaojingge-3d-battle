/**
 * 技能瞄准指示器组件（SpellAimIndicator）。
 * 职责：
 *   1. 当 store 中 spellAimState 非 null 时，在 3D 场景中渲染技能范围预览
 *   2. 支持 4 种指示器形态：
 *      - target_unit / target_point：施法范围圆 + AOE 效果圆
 *      - directional：施法范围圆 + 方向矩形/线条
 *      - self_cast：不渲染（在 SkillBar 中直接释放）
 *   3. 鼠标位置跟踪使用 ref 避免高频 store 更新
 *   4. useFrame 驱动指示器位置/朝向实时更新
 *
 * 性能策略：
 *   - 未处于瞄准模式时直接返回 null，不创建任何 Three.js 对象
 *   - 几何体和材质使用 useMemo 缓存
 *   - 鼠标地面交点使用 useRef 存储，不触发 React 渲染
 *   - 使用 depthWrite: false + transparent 避免排序开销
 */

import React, { useMemo, useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore } from '../../store/useGameStore';

// ==================== 常量 ====================

/** 范围圆颜色（蓝色系） */
const RANGE_CIRCLE_COLOR = 0x4488ff;
/** 方向矩形颜色（青色系） */
const DIRECTIONAL_COLOR = 0x44ddff;
/** AOE 效果圆颜色（橙色系） */
const AOE_CIRCLE_COLOR = 0xff8844;
/** 范围圆环宽度 */
const RANGE_RING_WIDTH = 0.12;
/** AOE 效果圆环宽度 */
const AOE_RING_WIDTH = 0.08;
/** 指示器 Y 轴偏移（略高于地面避免 z-fighting） */
const INDICATOR_Y_OFFSET = 0.06;
/** 方向矩形默认宽度 */
const DEFAULT_DIRECTIONAL_WIDTH = 1.0;
/** 瞄准态写回 store 的最小坐标变化阈值。 */
const AIM_SYNC_EPSILON = 0.02;

// ==================== 射线检测复用对象 ====================

const RAYCASTER = new THREE.Raycaster();
const POINTER = new THREE.Vector2();
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const INTERSECTION = new THREE.Vector3();

function arePointsClose(
  a?: { x: number; y: number; z: number } | null,
  b?: { x: number; y: number; z: number } | null,
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return Math.abs(a.x - b.x) <= AIM_SYNC_EPSILON
    && Math.abs(a.y - b.y) <= AIM_SYNC_EPSILON
    && Math.abs(a.z - b.z) <= AIM_SYNC_EPSILON;
}

function toSerializedVector3(vector: THREE.Vector3): { x: number; y: number; z: number } {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

// ==================== 施法范围圆 ====================

/** 范围圆脉冲动画速度（弧度/秒） */
const RANGE_PULSE_SPEED = 3;
/** 目标高亮光圈颜色（红色系） */
const TARGET_HIGHLIGHT_COLOR = 0xff4444;
/** 合法目标高亮光圈颜色（绿色系） */
const TARGET_ALLOWED_HIGHLIGHT_COLOR = 0x55dd88;

/**
 * 施法范围圆：在英雄脚下渲染半透明环形，显示技能最大施法距离。
 * 带有周期性脉冲呼吸动画，提升瞵准时的视觉反馈。
 */
const RangeCircle: React.FC<{ range: number }> = ({ range }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  /** 脉冲动画累积时间 */
  const pulseRef = useRef(0);

  const geometry = useMemo(() => {
    const inner = Math.max(0, range - RANGE_RING_WIDTH);
    return new THREE.RingGeometry(inner, range, 64);
  }, [range]);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: RANGE_CIRCLE_COLOR,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    /* 获取受控英雄位置 */
    const me = useGameStore.getState().champions.find((c) => c.isMe);
    if (!me) return;
    mesh.position.set(me.position.x, INDICATOR_Y_OFFSET, me.position.z);
    mesh.rotation.x = -Math.PI / 2;

    /* 脉冲呼吸动画：透明度和缩放周期性变化 */
    pulseRef.current += RANGE_PULSE_SPEED * delta;
    const pulseValue = Math.sin(pulseRef.current);
    (material as THREE.MeshBasicMaterial).opacity = 0.28 + pulseValue * 0.08;
    const scaleAdjust = 1 + pulseValue * 0.01;
    mesh.scale.set(scaleAdjust, scaleAdjust, 1);
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} castShadow={false} receiveShadow={false} />
  );
};

// ==================== 目标高亮光圈 ====================

/**
 * 目标高亮光圈：target_unit 模式下，当鼠标悬停在敌方单位上时，在目标脚下渲染红色高亮光圈。
 * 提示玩家当前悬停的目标可以被选中。
 */
const TargetHighlight: React.FC = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  /** 光圈脉冲累积时间 */
  const pulseRef = useRef(0);

  const geometry = useMemo(() => new THREE.RingGeometry(0.5, 0.7, 32), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: TARGET_HIGHLIGHT_COLOR,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const aim = useGameStore.getState().spellAimState;
    const hoveredId = aim?.hoveredTargetEntityId;
    const hoveredAllowed = aim?.hoveredTargetAllowed;

    /* 无悬停目标时隐藏 */
    if (!hoveredId) {
      mesh.visible = false;
      return;
    }

    /* 查找悬停目标的位置 */
    const target = useGameStore.getState().champions.find((c) => c.id === hoveredId);
    if (!target) {
      mesh.visible = false;
      return;
    }

    mesh.visible = true;
    mesh.position.set(target.position.x, INDICATOR_Y_OFFSET + 0.02, target.position.z);
    mesh.rotation.x = -Math.PI / 2;
    (material as THREE.MeshBasicMaterial).color.setHex(hoveredAllowed ? TARGET_ALLOWED_HIGHLIGHT_COLOR : TARGET_HIGHLIGHT_COLOR);

    /* 光圈脉冲动画 */
    pulseRef.current += 4 * delta;
    const pulseValue = Math.sin(pulseRef.current);
    (material as THREE.MeshBasicMaterial).opacity = 0.45 + pulseValue * 0.15;
    const s = 1 + pulseValue * 0.06;
    mesh.scale.set(s, s, 1);
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} castShadow={false} receiveShadow={false} />
  );
};

// ==================== 方向矩形指示器 ====================

/**
 * 方向矩形指示器：从英雄位置向鼠标方向延伸的矩形范围预览。
 * 用于 directional 类型技能（如亚索 Q、W）。
 */
const DirectionalRect: React.FC<{
  range: number;
  width: number;
  cursorRef: React.RefObject<THREE.Vector3>;
}> = ({ range, width, cursorRef }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(width, range),
    [width, range],
  );

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: DIRECTIONAL_COLOR,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    const cursor = cursorRef.current;
    if (!mesh || !cursor) return;

    const me = useGameStore.getState().champions.find((c) => c.isMe);
    if (!me) return;

    /* 计算英雄到鼠标的方向角 */
    const dx = cursor.x - me.position.x;
    const dz = cursor.z - me.position.z;
    const angle = Math.atan2(dx, dz);

    /* 矩形中心点：英雄前方 range/2 处 */
    const halfRange = range / 2;
    mesh.position.set(
      me.position.x + Math.sin(angle) * halfRange,
      INDICATOR_Y_OFFSET,
      me.position.z + Math.cos(angle) * halfRange,
    );
    /* 贴地 + 朝向鼠标方向 */
    mesh.rotation.set(-Math.PI / 2, 0, -angle);
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} castShadow={false} receiveShadow={false} />
  );
};

// ==================== 方向线端点标记 ====================

/**
 * 方向线端点标记：在方向指示器末端渲染一个小三角形箭头。
 */
const DirectionalArrow: React.FC<{
  range: number;
  cursorRef: React.RefObject<THREE.Vector3>;
}> = ({ range, cursorRef }) => {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.3);
    shape.lineTo(-0.25, -0.1);
    shape.lineTo(0.25, -0.1);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, []);

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: DIRECTIONAL_COLOR,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    const cursor = cursorRef.current;
    if (!mesh || !cursor) return;

    const me = useGameStore.getState().champions.find((c) => c.isMe);
    if (!me) return;

    const dx = cursor.x - me.position.x;
    const dz = cursor.z - me.position.z;
    const angle = Math.atan2(dx, dz);

    /* 箭头位于方向末端 */
    mesh.position.set(
      me.position.x + Math.sin(angle) * range,
      INDICATOR_Y_OFFSET,
      me.position.z + Math.cos(angle) * range,
    );
    mesh.rotation.set(-Math.PI / 2, 0, -angle);
  });

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} castShadow={false} receiveShadow={false} />
  );
};

// ==================== AOE 效果圆 ====================

/**
 * AOE 效果圆：在鼠标指向的地面位置渲染技能影响范围。
 * 用于 target_point 类型且有 radius 的技能。
 */
const AoeCircle: React.FC<{
  radius: number;
  range: number;
  cursorRef: React.RefObject<THREE.Vector3>;
}> = ({ radius, range, cursorRef }) => {
  const meshRef = useRef<THREE.Group>(null);

  const geometry = useMemo(() => {
    const inner = Math.max(0, radius - AOE_RING_WIDTH);
    return new THREE.RingGeometry(inner, radius, 48);
  }, [radius]);

  /** AOE 填充面：半透明圆形 */
  const fillGeometry = useMemo(
    () => new THREE.CircleGeometry(radius, 48),
    [radius],
  );

  const ringMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: AOE_CIRCLE_COLOR,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  const fillMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: AOE_CIRCLE_COLOR,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    const cursor = cursorRef.current;
    if (!mesh || !cursor) return;

    const me = useGameStore.getState().champions.find((c) => c.isMe);
    if (!me) return;

    /* 将鼠标位置限制在施法范围内 */
    const dx = cursor.x - me.position.x;
    const dz = cursor.z - me.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let targetX = cursor.x;
    let targetZ = cursor.z;
    if (dist > range && dist > 0.001) {
      const ratio = range / dist;
      targetX = me.position.x + dx * ratio;
      targetZ = me.position.z + dz * ratio;
    }

    mesh.position.set(targetX, INDICATOR_Y_OFFSET, targetZ);
    mesh.rotation.x = -Math.PI / 2;
  });

  return (
    <group ref={meshRef}>
      <mesh geometry={fillGeometry} material={fillMaterial} castShadow={false} receiveShadow={false} />
      <mesh geometry={geometry} material={ringMaterial} position={[0, 0.001, 0]} castShadow={false} receiveShadow={false} />
    </group>
  );
};

// ==================== 主组件 ====================

/**
 * 技能瞄准指示器入口组件。
 * 根据 store 中的 spellAimState 决定渲染哪些子指示器。
 */
const SpellAimIndicator: React.FC = () => {
  const spellAimState = useGameStore((s) => s.spellAimState);
  const { camera, gl } = useThree();

  /** 鼠标地面交点坐标（ref 避免高频 store 更新）。 */
  const cursorWorldRef = useRef<THREE.Vector3>(new THREE.Vector3());
  /** 上一次同步到 store 的瞄准结果快照。 */
  const lastSyncedAimRef = useRef<{
    cursorWorldPosition: { x: number; y: number; z: number } | null;
    targetPoint: { x: number; y: number; z: number } | null;
    targetDirection: { x: number; y: number; z: number } | null;
  }>({
    cursorWorldPosition: null,
    targetPoint: null,
    targetDirection: null,
  });

  /** 注册鼠标移动事件，实时更新地面交点。 */
  useEffect(() => {
    if (!spellAimState) return;

    const handleMouseMove = (event: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      POINTER.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      POINTER.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      RAYCASTER.setFromCamera(POINTER, camera);
      const hit = RAYCASTER.ray.intersectPlane(GROUND_PLANE, INTERSECTION);
      if (hit) {
        cursorWorldRef.current.set(hit.x, 0, hit.z);
      }
    };

    gl.domElement.addEventListener('mousemove', handleMouseMove);
    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
    };
  }, [spellAimState, camera, gl.domElement]);

  /**
   * 将当前鼠标地面点转换成正式瞄准输入。
   * directional / target_point 会回写有效目标点；
   * target_unit 仅同步鼠标地面点，单位命中由 InputController 负责。
   */
  useFrame(() => {
    const aim = useGameStore.getState().spellAimState;
    if (!aim) {
      lastSyncedAimRef.current = {
        cursorWorldPosition: null,
        targetPoint: null,
        targetDirection: null,
      };
      return;
    }

    const me = useGameStore.getState().champions.find((c) => c.id === aim.casterId) ?? null;
    if (!me) {
      return;
    }

    const cursorWorldPosition = toSerializedVector3(cursorWorldRef.current);
    let targetPoint = aim.targetPoint ?? null;
    let targetDirection = aim.targetDirection ?? null;

    if (aim.targetType === 'directional' || aim.targetType === 'target_point') {
      const dx = cursorWorldRef.current.x - me.position.x;
      const dz = cursorWorldRef.current.z - me.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const clampedDistance = distance > 0.001 ? Math.min(distance, aim.range) : 0;
      const normalizedX = distance > 0.001 ? dx / distance : 0;
      const normalizedZ = distance > 0.001 ? dz / distance : 1;
      const clampedPoint = new THREE.Vector3(
        me.position.x + normalizedX * clampedDistance,
        0,
        me.position.z + normalizedZ * clampedDistance,
      );

      targetPoint = toSerializedVector3(clampedPoint);
      targetDirection = {
        x: normalizedX,
        y: 0,
        z: normalizedZ,
      };
    }

    const lastSynced = lastSyncedAimRef.current;
    const shouldSync = !arePointsClose(lastSynced.cursorWorldPosition, cursorWorldPosition)
      || !arePointsClose(lastSynced.targetPoint, targetPoint)
      || !arePointsClose(lastSynced.targetDirection, targetDirection);

    if (!shouldSync) {
      return;
    }

    lastSyncedAimRef.current = {
      cursorWorldPosition,
      targetPoint,
      targetDirection,
    };

    useGameStore.getState().updateSpellAim({
      cursorWorldPosition,
      targetPoint,
      targetDirection,
    });
  });

  /* 未处于瞄准模式时不渲染任何内容 */
  if (!spellAimState) {
    return null;
  }

  const { targetType, range, radius, width } = spellAimState;

  /* self_cast 类型不需要指示器 */
  if (targetType === 'self_cast') {
    return null;
  }

  return (
    <group name="spell-aim-indicator">
      {/* 施法范围圆：所有需要瞄准的技能都显示 */}
      <RangeCircle range={range} />

      {/* 方向矩形 + 箭头：仅 directional 类型 */}
      {targetType === 'directional' && (
        <>
          <DirectionalRect
            range={range}
            width={width ?? DEFAULT_DIRECTIONAL_WIDTH}
            cursorRef={cursorWorldRef}
          />
          <DirectionalArrow range={range} cursorRef={cursorWorldRef} />
        </>
      )}

      {/* AOE 效果圆：target_point 类型且有 radius 时显示 */}
      {targetType === 'target_point' && radius != null && radius > 0 && (
        <AoeCircle radius={radius} range={range} cursorRef={cursorWorldRef} />
      )}

      {/* target_unit 类型：范围圆 + 悬停目标高亮光圈 */}
      {targetType === 'target_unit' && (
        <TargetHighlight />
      )}
    </group>
  );
};

export default React.memo(SpellAimIndicator);
