import React, { useMemo, useRef } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { FloatingCombatTextState } from '../../types/game';
import { useGameStore } from '../../store/useGameStore';

function getTextColor(kind: FloatingCombatTextState['kind']): string {
  switch (kind) {
    case 'heal':
      return '#4ade80';
    case 'shield':
      return '#7dd3fc';
    default:
      return '#fef2f2';
  }
}

function formatCombatText(text: FloatingCombatTextState): string {
  const prefix = text.kind === 'heal' ? '+' : text.kind === 'shield' ? '盾+' : '-';
  return `${prefix}${Math.round(text.amount)}`;
}

const FloatingCombatTextItem: React.FC<{ text: FloatingCombatTextState }> = ({ text }) => {
  const groupRef = useRef<THREE.Group>(null);
  const textRef = useRef<any>(null);
  const basePosition = useMemo(
    () => new THREE.Vector3(text.position.x, text.position.y, text.position.z),
    [text.position.x, text.position.y, text.position.z],
  );

  useFrame(() => {
    const group = groupRef.current;
    const label = textRef.current;
    if (!group || !label) {
      return;
    }

    const totalLifetime = Math.max(1, text.expiresAt - text.createdAt);
    const progress = THREE.MathUtils.clamp((Date.now() - text.createdAt) / totalLifetime, 0, 1);
    group.position.copy(basePosition);
    group.position.y += 1.5 + progress * 1.2;

    const material = Array.isArray(label.material) ? label.material[0] : label.material;
    if (material) {
      material.transparent = true;
      material.opacity = 1 - progress;
    }

    const scale = 1 + progress * 0.18;
    group.scale.set(scale, scale, scale);
  });

  return (
    <group ref={groupRef}>
      <Text
        ref={textRef}
        fontSize={text.kind === 'damage' ? 0.42 : 0.34}
        color={getTextColor(text.kind)}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.04}
        outlineColor="#0f172a"
        renderOrder={20}
      >
        {formatCombatText(text)}
      </Text>
    </group>
  );
};

const FloatingCombatTextSystem: React.FC = () => {
  const floatingCombatTexts = useGameStore((s) => s.floatingCombatTexts);

  if (floatingCombatTexts.length === 0) {
    return null;
  }

  return (
    <group name="floating-combat-text-system">
      {floatingCombatTexts.map((text) => (
        <FloatingCombatTextItem key={text.id} text={text} />
      ))}
    </group>
  );
};

export default React.memo(FloatingCombatTextSystem);
