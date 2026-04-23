import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GAME_CONFIG } from '../../config/gameConfig';
import { CAMERA_CONFIG } from '../../config/cameraConfig';
import { isTargetAllowedByRules } from '../../config/skillDefinitions';
import { MAP_CONFIG } from '../../config/mapConfig';
import { emitMoveCommand, emitStopCommand } from '../../network/socketClient';
import { useGameStore } from '../../store/useGameStore';

const MOVE_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const RAYCASTER = new THREE.Raycaster();
const POINTER = new THREE.Vector2();
const INTERSECTION = new THREE.Vector3();

const InputController: React.FC = () => {
  const { camera, gl, scene } = useThree();
  const me = useGameStore((s) => s.champions.find((champion) => champion.isMe) ?? null);
  const togglePlayerCameraLock = useGameStore((s) => s.togglePlayerCameraLock);
  const toggleDirectorMode = useGameStore((s) => s.toggleDirectorMode);
  const cycleSpectatorTarget = useGameStore((s) => s.cycleSpectatorTarget);
  const focusControlledChampion = useGameStore((s) => s.focusControlledChampion);
  const toggleWorldCoordinates = useGameStore((s) => s.toggleWorldCoordinates);
  const toggleDebugFreeCamera = useGameStore((s) => s.toggleDebugFreeCamera);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const debugFreeCamera = useGameStore((s) => s.debugFreeCamera);
  const showMoveIndicator = useGameStore((s) => s.showMoveIndicator);
  const setChampionMoveTarget = useGameStore((s) => s.setChampionMoveTarget);
  const stopChampion = useGameStore((s) => s.stopChampion);
  const cursorConfig = GAME_CONFIG.input.rightClickIndicator.cursor;
  const spectatorConfig = GAME_CONFIG.input.spectator;
  const debugConfig = GAME_CONFIG.debug.worldCoordinates;
  const multiplayerEnabled = GAME_CONFIG.multiplayer.enabled;

  const meId = me?.id ?? null;

  useEffect(() => {
    if (!meId) return;
    if (!me) return;

    const controlledChampion = me;

    const setPointerFromEvent = (event: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      POINTER.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      POINTER.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      RAYCASTER.setFromCamera(POINTER, camera);
    };

    const getGroundIntersection = (event: MouseEvent): THREE.Vector3 | null => {
      setPointerFromEvent(event);
      const hit = RAYCASTER.ray.intersectPlane(MOVE_PLANE, INTERSECTION);
      if (!hit) return null;
      return new THREE.Vector3(hit.x, 0, hit.z);
    };

    const getTargetChampionFromEvent = (event: MouseEvent) => {
      setPointerFromEvent(event);
      const intersections = RAYCASTER.intersectObjects(scene.children, true);
      for (const intersection of intersections) {
        let current: THREE.Object3D | null = intersection.object;
        while (current) {
          const userData = current.userData as {
            entityType?: string;
            championId?: string;
          };
          if (userData?.entityType === 'champion' && typeof userData.championId === 'string') {
            const liveChampions = useGameStore.getState().champions;
            const targetChampion = liveChampions.find((champion) => champion.id === userData.championId) ?? null;
            if (!targetChampion || targetChampion.isDead) {
              current = current.parent;
              continue;
            }
            return targetChampion;
          }
          current = current.parent;
        }
      }
      return null;
    };

    const isPlayablePoint = (point: THREE.Vector3) => (
      point.x >= MAP_CONFIG.playableBounds.minX
      && point.x <= MAP_CONFIG.playableBounds.maxX
      && point.z >= MAP_CONFIG.playableBounds.minZ
      && point.z <= MAP_CONFIG.playableBounds.maxZ
    );

    const buildCursorValue = (path: string) => `url(${path}) ${cursorConfig.hotspotX} ${cursorConfig.hotspotY}, ${cursorConfig.fallback}`;
    const cursorHost = gl.domElement.parentElement;

    const resetCursor = () => {
      const value = cursorConfig.enabled ? buildCursorValue(cursorConfig.defaultPath) : cursorConfig.fallback;
      gl.domElement.style.cursor = value;
      if (cursorHost) {
        cursorHost.style.cursor = value;
      }
    };

    const flashClickCursor = () => {
      if (!cursorConfig.enabled || !cursorConfig.clickPath) {
        return;
      }

      const value = buildCursorValue(cursorConfig.clickPath);
      gl.domElement.style.cursor = value;
      if (cursorHost) {
        cursorHost.style.cursor = value;
      }
      window.setTimeout(resetCursor, cursorConfig.clickFeedbackMs);
    };

    resetCursor();

    const handleMouseMove = (event: MouseEvent) => {
      const aim = useGameStore.getState().spellAimState;
      if (!aim || aim.targetType !== 'target_unit') {
        return;
      }
      const targetChampion = getTargetChampionFromEvent(event);
      const isAllowedByRules = !!targetChampion && isTargetAllowedByRules(controlledChampion, targetChampion, aim.targetRules);
      const isInRange = !!targetChampion && controlledChampion.position.distanceTo(targetChampion.position) <= aim.range + 0.001;
      const hoveredTargetEntityId = targetChampion?.id ?? null;
      const hoveredTargetAllowed = !!targetChampion && isAllowedByRules && isInRange;
      if (aim.hoveredTargetEntityId === hoveredTargetEntityId && aim.hoveredTargetAllowed === hoveredTargetAllowed) {
        return;
      }
      useGameStore.getState().updateSpellAim({
        hoveredTargetEntityId,
        hoveredTargetAllowed,
      });
    };

    const handleMouseDown = (event: MouseEvent) => {
      const aim = useGameStore.getState().spellAimState;
      if (aim && event.button === 0 && aim.targetType === 'target_unit') {
        event.preventDefault();
        const targetChampion = getTargetChampionFromEvent(event);
        const isAllowedByRules = !!targetChampion && isTargetAllowedByRules(controlledChampion, targetChampion, aim.targetRules);
        const isInRange = !!targetChampion && controlledChampion.position.distanceTo(targetChampion.position) <= aim.range + 0.001;
        const isAllowed = !!targetChampion && isAllowedByRules && isInRange;
        if (!targetChampion || !isAllowed) {
          useGameStore.getState().updateSpellAim({
            hoveredTargetEntityId: targetChampion?.id ?? null,
            hoveredTargetAllowed: false,
            targetEntityId: null,
          });
          return;
        }
        useGameStore.getState().updateSpellAim({
          hoveredTargetEntityId: targetChampion.id,
          hoveredTargetAllowed: true,
          targetEntityId: targetChampion.id,
        });
        return;
      }

      if (event.button !== 2) return;
      event.preventDefault();
      /* 断线状态下禁止发送任何操作命令 */
      if (multiplayerEnabled && useGameStore.getState().multiplayerSession.status !== 'connected') return;
      /* 瞄准模式下右键由 SkillBar 处理（取消瞄准），不发送移动命令 */
      if (useGameStore.getState().spellAimState) return;
      if ((cameraMode !== 'playerLocked' && cameraMode !== 'spectatorFollow') || debugFreeCamera) return;
      if (!me?.isMe || cameraMode !== 'playerLocked') return;
      const point = getGroundIntersection(event);
      if (!point) return;
      if (!isPlayablePoint(point)) return;
      flashClickCursor();
      setChampionMoveTarget(meId, point, 'mouse');
      if (multiplayerEnabled) {
        emitMoveCommand({
          championId: meId,
          target: { x: point.x, y: point.y, z: point.z },
          targetPoint: { x: point.x, y: point.y, z: point.z },
          inputMode: 'mouse' as const,
        });
      }
      showMoveIndicator(point);
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      if (event.code === CAMERA_CONFIG.lockToggleKey) {
        togglePlayerCameraLock();
        return;
      }

      if (event.code === spectatorConfig.toggleModeKey) {
        toggleDirectorMode();
        return;
      }

      if (event.code === spectatorConfig.previousTargetKey) {
        cycleSpectatorTarget(-1);
        return;
      }

      if (event.code === spectatorConfig.nextTargetKey) {
        cycleSpectatorTarget(1);
        return;
      }

      if (event.code === spectatorConfig.focusMeKey) {
        focusControlledChampion();
        return;
      }

      if (event.code === 'KeyS') {
        if (!me?.isMe || cameraMode !== 'playerLocked') {
          return;
        }
        /* 断线状态下禁止发送停止命令 */
        if (multiplayerEnabled && useGameStore.getState().multiplayerSession.status !== 'connected') return;
        stopChampion(meId);
        if (multiplayerEnabled) {
          emitStopCommand({ championId: meId });
        }
        return;
      }

      if (event.code === debugConfig.toggleKey) {
        toggleWorldCoordinates();
        return;
      }

      if (event.code === GAME_CONFIG.debug.freeCamera.toggleKey) {
        toggleDebugFreeCamera();
      }
    };

    gl.domElement.addEventListener('mousemove', handleMouseMove);
    gl.domElement.addEventListener('mousedown', handleMouseDown);
    gl.domElement.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      gl.domElement.removeEventListener('mousedown', handleMouseDown);
      gl.domElement.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      gl.domElement.style.cursor = '';
      if (cursorHost) {
        cursorHost.style.cursor = '';
      }
    };
  }, [camera, cameraMode, cursorConfig.clickFeedbackMs, cursorConfig.clickPath, cursorConfig.defaultPath, cursorConfig.enabled, cursorConfig.fallback, cursorConfig.hotspotX, cursorConfig.hotspotY, cycleSpectatorTarget, debugConfig.toggleKey, debugFreeCamera, focusControlledChampion, gl.domElement, me, meId, multiplayerEnabled, scene.children, setChampionMoveTarget, showMoveIndicator, spectatorConfig.focusMeKey, spectatorConfig.nextTargetKey, spectatorConfig.previousTargetKey, spectatorConfig.toggleModeKey, stopChampion, toggleDebugFreeCamera, toggleDirectorMode, togglePlayerCameraLock, toggleWorldCoordinates]);

  return null;
};

export default InputController;
