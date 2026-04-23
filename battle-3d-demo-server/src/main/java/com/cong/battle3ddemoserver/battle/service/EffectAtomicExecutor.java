package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.BattleRoom;
import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import com.cong.battle3ddemoserver.battle.model.ProjectileState;
import com.cong.battle3ddemoserver.battle.model.AreaEffectState;
import com.cong.battle3ddemoserver.battle.model.StatusEffectInstance;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 效果原子执行器。
 * 提供伤害、治疗、护盾、状态施加/移除、投射物生成、区域体生成等最小执行入口。
 * 所有效果修改均直接作用于服务端权威状态模型。
 */
@Slf4j
@Service
public class EffectAtomicExecutor {
    private final StatusEffectService statusEffectService;
    private final ProjectileService projectileService;
    private final AreaEffectService areaEffectService;
    private final BattleRoomManager battleRoomManager;
    private final BattleBroadcastService battleBroadcastService;

    public EffectAtomicExecutor(StatusEffectService statusEffectService, ProjectileService projectileService,
                                AreaEffectService areaEffectService, BattleRoomManager battleRoomManager,
                                BattleBroadcastService battleBroadcastService) {
        this.statusEffectService = statusEffectService;
        this.projectileService = projectileService;
        this.areaEffectService = areaEffectService;
        this.battleRoomManager = battleRoomManager;
        this.battleBroadcastService = battleBroadcastService;
    }

    /**
     * 对目标施加伤害。
     * 当前阶段为扁平伤害计算，后续扩展护甲/魔抗/伤害类型等计算链。
     * 伤害优先消耗护盾，剩余部分扣除生命值。
     */
    public void applyDamage(BattleChampionState target, double amount) {
        applyDamage(null, null, null, null, target, amount);
    }

    /**
     * 对目标施加伤害，并广播 DamageApplied / DeathOccurred 权威事件。
     */
    public void applyDamage(String sourceEntityId, String castInstanceId, String skillId, String slot,
                            BattleChampionState target, double amount) {
        if (target == null || target.getHp() == null) {
            return;
        }
        double actualDamage = Math.max(0D, amount);
        double absorbedByShield = 0D;
        /* 优先消耗护盾 */
        double shield = target.getShield() != null ? target.getShield() : 0D;
        if (shield > 0D) {
            if (shield >= actualDamage) {
                target.setShield(shield - actualDamage);
                absorbedByShield = actualDamage;
                broadcastDamageApplied(sourceEntityId, castInstanceId, skillId, slot, target,
                        actualDamage, absorbedByShield, target.getShield() != null ? target.getShield() : 0D, false);
                broadcastShieldChanged(sourceEntityId, castInstanceId, skillId, slot, target,
                        -absorbedByShield, target.getShield() != null ? target.getShield() : 0D);
                return;
            }
            absorbedByShield = shield;
            actualDamage -= shield;
            target.setShield(0D);
            broadcastShieldChanged(sourceEntityId, castInstanceId, skillId, slot, target, -absorbedByShield, 0D);
        }
        double nextHp = Math.max(0D, target.getHp() - actualDamage);
        target.setHp(nextHp);
        boolean targetDied = nextHp <= 0D;
        if (targetDied) {
            target.setDead(Boolean.TRUE);
            target.setAnimationState("death");
            target.setMoveTarget(null);
        }
        broadcastDamageApplied(sourceEntityId, castInstanceId, skillId, slot, target,
                actualDamage + absorbedByShield, absorbedByShield, target.getShield() != null ? target.getShield() : 0D, targetDied);
        if (targetDied) {
            broadcastDeathOccurred(sourceEntityId, castInstanceId, skillId, slot, target);
        }
    }

    /**
     * 对目标施加治疗。
     */
    public void applyHeal(BattleChampionState target, double amount) {
        applyHeal(null, null, null, null, target, amount);
    }

    /**
     * 对目标施加治疗，并广播 HealApplied 事件。
     */
    public void applyHeal(String sourceEntityId, String castInstanceId, String skillId, String slot,
                          BattleChampionState target, double amount) {
        if (target == null || target.getHp() == null || target.getMaxHp() == null) {
            return;
        }
        double actualHeal = Math.max(0D, amount);
        double oldHp = target.getHp();
        target.setHp(Math.min(target.getMaxHp(), oldHp + actualHeal));
        double finalHeal = target.getHp() - oldHp;
        if (finalHeal > 0D) {
            broadcastHealApplied(sourceEntityId, castInstanceId, skillId, slot, target, finalHeal);
        }
    }

    /**
     * 对目标施加护盾。
     * 护盾值直接叠加到现有护盾上（不覆盖）。
     */
    public void applyShield(BattleChampionState target, double amount) {
        applyShield(null, null, null, null, target, amount);
    }

    /**
     * 对目标施加护盾，并广播 ShieldChanged 事件。
     */
    public void applyShield(String sourceEntityId, String castInstanceId, String skillId, String slot,
                            BattleChampionState target, double amount) {
        if (target == null) {
            return;
        }
        double current = target.getShield() != null ? target.getShield() : 0D;
        double delta = Math.max(0D, amount);
        target.setShield(current + delta);
        if (delta > 0D) {
            broadcastShieldChanged(sourceEntityId, castInstanceId, skillId, slot, target, delta, target.getShield());
        }
    }

    /**
     * 对目标施加状态效果（Buff/Debuff）。
     */
    public void applyStatus(String statusId, String sourceEntityId, BattleChampionState target, int stacks, long durationMs) {
        applyStatus(null, null, null, statusId, sourceEntityId, target, stacks, durationMs);
    }

    /**
     * 对目标施加状态效果（Buff/Debuff），并广播 StatusApplied 事件。
     */
    public void applyStatus(String castInstanceId, String skillId, String slot, String statusId,
                            String sourceEntityId, BattleChampionState target, int stacks, long durationMs) {
        if (target == null) {
            return;
        }
        StatusEffectInstance instance = statusEffectService.apply(statusId, sourceEntityId, target.getId(), stacks, durationMs);
        broadcastStatusApplied(castInstanceId, skillId, slot, instance);
    }

    /**
     * 对目标施加状态效果（按实体 ID 操作，用于投射物命中等场景）。
     */
    public void applyStatus(String sourceEntityId, String targetEntityId, String statusId, long durationMs, int stacks) {
        applyStatus(null, null, null, sourceEntityId, targetEntityId, statusId, durationMs, stacks);
    }

    /**
     * 对目标施加状态效果（按实体 ID 操作），并广播 StatusApplied 事件。
     */
    public void applyStatus(String castInstanceId, String skillId, String slot,
                            String sourceEntityId, String targetEntityId, String statusId,
                            long durationMs, int stacks) {
        if (targetEntityId == null) {
            return;
        }
        StatusEffectInstance instance = statusEffectService.apply(statusId, sourceEntityId, targetEntityId, stacks, durationMs);
        broadcastStatusApplied(castInstanceId, skillId, slot, instance);
    }

    /**
     * 移除目标身上的指定状态效果。
     */
    public void removeStatus(String statusId, BattleChampionState target, boolean removeAllStacks) {
        removeStatus(null, null, null, statusId, target, removeAllStacks);
    }

    /**
     * 移除目标身上的指定状态效果，并广播 StatusRemoved 事件。
     */
    public void removeStatus(String castInstanceId, String skillId, String slot,
                             String statusId, BattleChampionState target, boolean removeAllStacks) {
        if (target == null) {
            return;
        }
        List<StatusEffectInstance> removedStatuses = statusEffectService.remove(target.getId(), statusId, removeAllStacks);
        broadcastStatusRemoved(castInstanceId, skillId, slot, removedStatuses, "removed");
    }

    /**
     * 移除目标身上的指定状态效果（按实体 ID 操作）。
     */
    public void removeStatus(String targetEntityId, String statusId) {
        removeStatus(null, null, null, targetEntityId, statusId);
    }

    /**
     * 移除目标身上的指定状态效果（按实体 ID 操作），并广播 StatusRemoved 事件。
     */
    public void removeStatus(String castInstanceId, String skillId, String slot,
                             String targetEntityId, String statusId) {
        if (targetEntityId == null) {
            return;
        }
        List<StatusEffectInstance> removedStatuses = statusEffectService.remove(targetEntityId, statusId, true);
        broadcastStatusRemoved(castInstanceId, skillId, slot, removedStatuses, "removed");
    }

    /**
     * 生成投射物（如亚索 Q3 龙卷风）。
     */
    public ProjectileState spawnProjectile(String castInstanceId, String ownerId, String skillId,
                                            BattleVector3 position, BattleVector3 direction,
                                            double speed, double radius, boolean blockable, long lifetimeMs) {
        return spawnProjectile(castInstanceId, ownerId, skillId, position, direction, speed, radius, blockable, lifetimeMs, null, null);
    }

    /**
     * 生成投射物（带队伍和变体 ID，用于碰撞检测和效果链回查）。
     */
    public ProjectileState spawnProjectile(String castInstanceId, String ownerId, String skillId,
                                            BattleVector3 position, BattleVector3 direction,
                                            double speed, double radius, boolean blockable, long lifetimeMs,
                                            String ownerTeam, String variantId) {
        ProjectileState projectile = projectileService.spawn(castInstanceId, ownerId, skillId, position, direction,
                speed, radius, blockable, lifetimeMs, ownerTeam, variantId);
        broadcastProjectileSpawned(castInstanceId, ownerId, skillId, projectile);
        log.debug("投射物已生成: projectileId={}, skillId={}, ownerId={}, variantId={}",
                projectile.getProjectileId(), skillId, ownerId, variantId);
        return projectile;
    }

    /**
     * 对目标施加通用位移效果（击退、击飞、拉拽等）。
     * 位移由服务端权威计算终点位置并直接更新目标坐标。
     * @param target 目标英雄
     * @param displaceType 位移类型：knockback / knockup / pull
     * @param direction 位移方向向量（需归一化）
     * @param distance 位移距离
     * @param durationMs 位移持续时长（毫秒），用于设置移动锁定
     */
    public void applyDisplacement(BattleChampionState target, String displaceType,
                                   BattleVector3 direction, double distance, long durationMs) {
        applyDisplacement(null, null, null, target, displaceType, direction, distance, durationMs);
    }

    /**
     * 对目标施加通用位移效果，并广播 DisplacementResolved 事件。
     */
    public void applyDisplacement(String sourceEntityId, String castInstanceId, String skillId,
                                  BattleChampionState target, String displaceType,
                                  BattleVector3 direction, double distance, long durationMs) {
        if (target == null || direction == null) {
            return;
        }
        long now = System.currentTimeMillis();
        /* 计算位移终点 */
        double dx = direction.getX();
        double dz = direction.getZ();
        double length = Math.sqrt(dx * dx + dz * dz);
        if (length > 0.001D) {
            dx = dx / length * distance;
            dz = dz / length * distance;
        }
        BattleVector3 currentPos = target.getPosition();
        if (currentPos != null) {
            currentPos.setX(currentPos.getX() + dx);
            currentPos.setZ(currentPos.getZ() + dz);
        }
        /* 位移期间锁定目标移动 */
        target.setMoveTarget(null);
        target.setMovementLockedUntil(now + durationMs);
        broadcastDisplacementResolved(sourceEntityId, castInstanceId, skillId, target, displaceType, distance, durationMs);
        log.debug("位移效果已施加: target={}, type={}, distance={}, durationMs={}",
                target.getId(), displaceType, distance, durationMs);
    }

    /**
     * 生成区域体（如亚索风墙、范围技能指示区域）。
     */
    public AreaEffectState spawnArea(String castInstanceId, String ownerId, String skillId,
                                      String areaType, BattleVector3 position, double radius,
                                      Double rotationY, Double length, Double width, Double height, long lifetimeMs) {
        AreaEffectState area = areaEffectService.create(castInstanceId, ownerId, skillId, areaType, position, radius, rotationY, length, width, height, lifetimeMs);
        broadcastAreaCreated(castInstanceId, ownerId, skillId, area);
        log.debug("区域体已生成: areaId={}, areaType={}, skillId={}, ownerId={}", area.getAreaId(), areaType, skillId, ownerId);
        return area;
    }

    private void broadcastDamageApplied(String sourceEntityId, String castInstanceId, String skillId, String slot,
                                        BattleChampionState target, double totalDamage, double absorbedByShield,
                                        double remainingShield, boolean targetDied) {
        if (target == null) {
            return;
        }
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("slot", slot);
        fields.put("sourceEntityId", sourceEntityId);
        fields.put("targetEntityId", target.getId());
        fields.put("amount", totalDamage);
        fields.put("absorbedByShield", absorbedByShield);
        fields.put("remainingShield", remainingShield);
        fields.put("currentHp", target.getHp());
        fields.put("targetDied", targetDied);
        fields.put("position", target.getPosition());
        broadcastCombatEvent("damage-applied", "DamageApplied", fields);
    }

    private void broadcastHealApplied(String sourceEntityId, String castInstanceId, String skillId, String slot,
                                      BattleChampionState target, double amount) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("slot", slot);
        fields.put("sourceEntityId", sourceEntityId);
        fields.put("targetEntityId", target.getId());
        fields.put("amount", amount);
        fields.put("currentHp", target.getHp());
        fields.put("position", target.getPosition());
        broadcastCombatEvent("heal-applied", "HealApplied", fields);
    }

    private void broadcastShieldChanged(String sourceEntityId, String castInstanceId, String skillId, String slot,
                                        BattleChampionState target, double delta, double currentShield) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("slot", slot);
        fields.put("sourceEntityId", sourceEntityId);
        fields.put("targetEntityId", target.getId());
        fields.put("delta", delta);
        fields.put("currentShield", currentShield);
        fields.put("position", target.getPosition());
        broadcastCombatEvent("shield-changed", "ShieldChanged", fields);
    }

    private void broadcastStatusApplied(String castInstanceId, String skillId, String slot,
                                        StatusEffectInstance instance) {
        if (instance == null) {
            return;
        }
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("slot", slot);
        fields.put("statusInstanceId", instance.getStatusInstanceId());
        fields.put("statusId", instance.getStatusId());
        fields.put("sourceEntityId", instance.getSourceEntityId());
        fields.put("targetEntityId", instance.getTargetEntityId());
        fields.put("stacks", instance.getStacks());
        fields.put("createdAt", instance.getCreatedAt());
        fields.put("expiresAt", instance.getExpiresAt());
        if (instance.getCreatedAt() != null && instance.getExpiresAt() != null && instance.getExpiresAt() != Long.MAX_VALUE) {
            fields.put("durationMs", instance.getExpiresAt() - instance.getCreatedAt());
        }
        broadcastCombatEvent("status-applied", "StatusApplied", fields);
    }

    private void broadcastStatusRemoved(String castInstanceId, String skillId, String slot,
                                        List<StatusEffectInstance> removedStatuses, String reason) {
        if (removedStatuses == null || removedStatuses.isEmpty()) {
            return;
        }
        for (StatusEffectInstance instance : removedStatuses) {
            Map<String, Object> fields = new LinkedHashMap<String, Object>();
            fields.put("castInstanceId", castInstanceId);
            fields.put("skillId", skillId);
            fields.put("slot", slot);
            fields.put("statusInstanceId", instance.getStatusInstanceId());
            fields.put("statusId", instance.getStatusId());
            fields.put("sourceEntityId", instance.getSourceEntityId());
            fields.put("targetEntityId", instance.getTargetEntityId());
            fields.put("stacks", instance.getStacks());
            fields.put("reason", reason);
            broadcastCombatEvent("status-removed", "StatusRemoved", fields);
        }
    }

    private void broadcastProjectileSpawned(String castInstanceId, String ownerId, String skillId, ProjectileState projectile) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("ownerId", ownerId);
        fields.put("projectileId", projectile.getProjectileId());
        fields.put("position", projectile.getPosition());
        fields.put("direction", projectile.getDirection());
        fields.put("speed", projectile.getSpeed());
        fields.put("radius", projectile.getRadius());
        fields.put("blockable", projectile.getBlockable());
        broadcastCombatEvent("projectile-spawned", "ProjectileSpawned", fields);
    }

    private void broadcastAreaCreated(String castInstanceId, String ownerId, String skillId, AreaEffectState area) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("ownerId", ownerId);
        fields.put("areaId", area.getAreaId());
        fields.put("areaType", area.getAreaType());
        fields.put("position", area.getPosition());
        fields.put("radius", area.getRadius());
        fields.put("rotationY", area.getRotationY());
        fields.put("length", area.getLength());
        fields.put("width", area.getWidth());
        fields.put("height", area.getHeight());
        fields.put("expiresAt", area.getExpiresAt());
        broadcastCombatEvent("area-created", "AreaCreated", fields);
    }

    private void broadcastDisplacementResolved(String sourceEntityId, String castInstanceId, String skillId,
                                               BattleChampionState target, String displaceType,
                                               double distance, long durationMs) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("sourceEntityId", sourceEntityId);
        fields.put("targetEntityId", target.getId());
        fields.put("displaceType", displaceType);
        fields.put("distance", distance);
        fields.put("durationMs", durationMs);
        fields.put("position", target.getPosition());
        fields.put("movementLockedUntil", target.getMovementLockedUntil());
        broadcastCombatEvent("displacement-resolved", "DisplacementResolved", fields);
    }

    private void broadcastDeathOccurred(String sourceEntityId, String castInstanceId, String skillId, String slot,
                                        BattleChampionState target) {
        Map<String, Object> fields = new LinkedHashMap<String, Object>();
        fields.put("castInstanceId", castInstanceId);
        fields.put("skillId", skillId);
        fields.put("slot", slot);
        fields.put("sourceEntityId", sourceEntityId);
        fields.put("targetEntityId", target.getId());
        fields.put("position", target.getPosition());
        broadcastCombatEvent("death-occurred", "DeathOccurred", fields);
    }

    private void broadcastCombatEvent(String eventIdPrefix, String eventType, Map<String, Object> fields) {
        BattleRoom room = battleRoomManager.getRoom();
        if (room == null) {
            return;
        }
        battleBroadcastService.broadcastCombatEvent(room, eventType, eventIdPrefix, System.currentTimeMillis(), fields);
    }
}
