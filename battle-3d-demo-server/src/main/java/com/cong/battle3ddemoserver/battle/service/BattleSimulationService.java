package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.*;
import com.cong.battle3ddemoserver.config.BattleServerProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 战斗 Tick 推进与快照广播服务。
 * 每个 Tick 依次推进：英雄移动、技能冷却递减、投射物位移、区域体/状态过期清理、技能阶段推进。
 * 快照广播包含完整的英雄状态、投射物、区域体和状态效果数据。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BattleSimulationService {
    private final BattleRoomManager battleRoomManager;
    private final SpellLifecycleService spellLifecycleService;
    private final BattleBroadcastService battleBroadcastService;
    private final BattleServerProperties battleServerProperties;
    private final ProjectileService projectileService;
    private final AreaEffectService areaEffectService;
    private final StatusEffectService statusEffectService;
    private final HeroSkillDefinitionService heroSkillDefinitionService;
    private final EffectAtomicExecutor effectAtomicExecutor;

    /** 上一次 Tick 的时间戳。 */
    private long lastTickTime = 0L;
    /** 快照序号递增器。 */
    private long snapshotSequence = 0L;
    /** 逻辑帧号递增器。 */
    private long tickFrame = 0L;

    /**
     * 建筑碰撞体列表（圆形碰撞）。
     * 每个元素：{x, z, radius}。
     * 坐标与前端 gameConfig.ts 中的 towers / nexuses / inhibitors 保持一致。
     */
    private static final double[][] STRUCTURE_COLLIDERS = {
            /* ===== 防御塔（碰撞半径 2.5） ===== */
            {-25, 0, 2.5},       // 蓝队外塔
            {-55, 0, 2.5},       // 蓝队内塔
            {-100, -5.4, 2.5},   // 蓝队左门牙塔
            {-100, 5.4, 2.5},    // 蓝队右门牙塔
            {25, 0, 2.5},        // 红队外塔
            {55, 0, 2.5},        // 红队内塔
            {100, -5.4, 2.5},    // 红队左门牙塔
            {100, 5.4, 2.5},     // 红队右门牙塔
            /* ===== 小水晶（碰撞半径 2.2） ===== */
            {-80, 0, 5.5},       // 蓝队小水晶
            {80, 0, 5.5},        // 红队小水晶
            /* ===== 水晶枢纽（碰撞半径） ===== */
            {-110, 0, 6.5},        // 蓝队水晶
            {115, 0, 6.5},         // 红队水晶
    };
    /** 英雄碰撞半径。 */
    private static final double CHAMPION_COLLISION_RADIUS = 0.5;

    /**
     * 主战斗 Tick：每帧推进所有运行时实体和系统。
     */
    @Scheduled(fixedRateString = "${battle.tick-interval-ms:50}")
    public void tick() {
        BattleRoom room = battleRoomManager.getRoom();
        if (room == null || room.getChampions() == null) {
            return;
        }
        long now = System.currentTimeMillis();
        double delta = lastTickTime > 0 ? (now - lastTickTime) / 1000.0 : 0.05;
        lastTickTime = now;
        tickFrame++;

        /* ---------- 1. 推进英雄移动 ---------- */
        for (BattleChampionState champion : room.getChampions()) {
            advanceMovement(champion, delta);
        }

        /* ---------- 2. 推进技能冷却递减 ---------- */
        long tickIntervalMs = battleServerProperties.getTickIntervalMs() != null ? battleServerProperties.getTickIntervalMs() : 50L;
        for (BattleChampionState champion : room.getChampions()) {
            advanceCooldowns(champion, tickIntervalMs);
        }

        /* ---------- 3. 推进投射物位移与碰撞检测 ---------- */
        ProjectileService.ProjectileTickResult projectileTickResult = projectileService.tick(delta, now);
        handleProjectileHits(room, projectileTickResult.getHitResults());
        broadcastProjectileDestroyed(room, projectileTickResult.getDestroyedResults(), now);

        /* ---------- 4. 清理过期区域体和状态效果 ---------- */
        List<AreaEffectState> expiredAreas = areaEffectService.cleanupExpired(now);
        broadcastAreaExpired(room, expiredAreas, now);
        List<StatusEffectInstance> expiredStatuses = statusEffectService.cleanupExpired(now);
        broadcastStatusRemoved(room, expiredStatuses, now, "expired");

        /* ---------- 5. 推进技能阶段 ---------- */
        room.setGameTimer(room.getGameTimer() + delta);
        List<SpellStageTransition> transitions = spellLifecycleService.advance(now);
        for (SpellStageTransition transition : transitions) {
            Map<String, Object> event = new LinkedHashMap<String, Object>();
            event.put("castInstanceId", transition.getCastInstanceId());
            event.put("casterId", transition.getCasterId());
            event.put("skillId", transition.getSkillId());
            event.put("slot", transition.getSlot());
            event.put("targetEntityId", transition.getTargetEntityId());
            event.put("targetPoint", transition.getTargetPoint());
            event.put("previousStage", transition.getPreviousStage());
            event.put("nextStage", transition.getNextStage());
            battleBroadcastService.broadcastCombatEvent(room, "spellStageChanged", "spell-stage-changed", now, event);
        }
    }

    /**
     * 定时广播战斗快照，包含英雄、投射物、区域体和状态效果的真实数据。
     */
    @Scheduled(fixedRateString = "${battle.snapshot-interval-ms:100}")
    public void emitSnapshot() {
        BattleRoom room = battleRoomManager.getRoom();
        if (room == null || room.getChampions() == null) {
            return;
        }
        snapshotSequence++;
        long now = System.currentTimeMillis();
        Map<String, Object> snapshot = new LinkedHashMap<String, Object>();
        snapshot.put("eventId", "snap-" + UUID.randomUUID().toString());
        snapshot.put("sequence", snapshotSequence);
        snapshot.put("roomId", room.getRoomId());
        snapshot.put("serverTime", now);
        snapshot.put("frame", tickFrame);
        snapshot.put("gameTimer", room.getGameTimer());

        /* ---------- 英雄实体快照 ---------- */
        List<Map<String, Object>> entities = new ArrayList<Map<String, Object>>();
        for (BattleChampionState champion : room.getChampions()) {
            entities.add(buildChampionSnapshot(champion));
        }
        snapshot.put("entities", entities);

        /* ---------- 玩家会话快照 ---------- */
        List<Map<String, Object>> players = new ArrayList<Map<String, Object>>();
        if (room.getPlayers() != null) {
            for (PlayerSession playerSession : room.getPlayers()) {
                Map<String, Object> ps = new LinkedHashMap<String, Object>();
                ps.put("sessionId", playerSession.getSessionId());
                ps.put("playerName", playerSession.getPlayerName());
                ps.put("championId", playerSession.getChampionId());
                ps.put("spectator", playerSession.getSpectator());
                players.add(ps);
            }
        }
        snapshot.put("players", players);

        /* ---------- 投射物快照 ---------- */
        List<Map<String, Object>> projectileSnapshots = new ArrayList<Map<String, Object>>();
        for (ProjectileState proj : projectileService.getActiveProjectiles()) {
            projectileSnapshots.add(buildProjectileSnapshot(proj));
        }
        snapshot.put("projectiles", projectileSnapshots);

        /* ---------- 区域体快照 ---------- */
        List<Map<String, Object>> areaSnapshots = new ArrayList<Map<String, Object>>();
        for (AreaEffectState area : areaEffectService.getActiveAreas()) {
            areaSnapshots.add(buildAreaSnapshot(area));
        }
        snapshot.put("areas", areaSnapshots);

        /* ---------- 状态效果快照 ---------- */
        List<Map<String, Object>> statusSnapshots = new ArrayList<Map<String, Object>>();
        for (StatusEffectInstance status : statusEffectService.getActiveStatusEffects()) {
            statusSnapshots.add(buildStatusSnapshot(status));
        }
        snapshot.put("statuses", statusSnapshots);

        battleBroadcastService.broadcast(room, "combatSnapshot", snapshot);
    }

    // ==================== 快照构建方法 ====================

    /**
     * 构建单个英雄的快照数据。
     */
    private Map<String, Object> buildChampionSnapshot(BattleChampionState champion) {
        Map<String, Object> entity = new LinkedHashMap<String, Object>();
        entity.put("id", champion.getId());
        entity.put("heroId", champion.getHeroId());
        entity.put("playerName", champion.getPlayerName());
        entity.put("team", champion.getTeam());
        entity.put("position", champion.getPosition());
        entity.put("rotation", champion.getRotation());
        entity.put("hp", champion.getHp());
        entity.put("maxHp", champion.getMaxHp());
        entity.put("mp", champion.getMp());
        entity.put("maxMp", champion.getMaxMp());
        entity.put("moveTarget", champion.getMoveTarget());
        entity.put("animationState", champion.getAnimationState());
        entity.put("dead", champion.getDead());
        entity.put("shield", champion.getShield());
        entity.put("flowValue", champion.getFlowValue());
        entity.put("skillStates", champion.getSkillStates());
        entity.put("activeCastInstanceId", champion.getActiveCastInstanceId());
        entity.put("activeCastPhase", champion.getActiveCastPhase());
        entity.put("movementLockedUntil", champion.getMovementLockedUntil());
        entity.put("idleStartedAt", champion.getIdleStartedAt());
        return entity;
    }

    /**
     * 构建单个投射物的快照数据，字段与前端 ProjectilePresentationState 对齐。
     */
    private Map<String, Object> buildProjectileSnapshot(ProjectileState proj) {
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("projectileId", proj.getProjectileId());
        data.put("castInstanceId", proj.getCastInstanceId());
        data.put("ownerId", proj.getOwnerId());
        data.put("skillId", proj.getSkillId());
        data.put("position", proj.getPosition());
        data.put("direction", proj.getDirection());
        data.put("speed", proj.getSpeed());
        data.put("radius", proj.getRadius());
        data.put("blockable", proj.getBlockable());
        return data;
    }

    /**
     * 构建单个区域体的快照数据，字段与前端 AreaPresentationState 对齐。
     */
    private Map<String, Object> buildAreaSnapshot(AreaEffectState area) {
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("areaId", area.getAreaId());
        data.put("castInstanceId", area.getCastInstanceId());
        data.put("ownerId", area.getOwnerId());
        data.put("skillId", area.getSkillId());
        data.put("areaType", area.getAreaType());
        data.put("position", area.getPosition());
        data.put("radius", area.getRadius());
        data.put("rotationY", area.getRotationY());
        data.put("length", area.getLength());
        data.put("width", area.getWidth());
        data.put("height", area.getHeight());
        data.put("expiresAt", area.getExpiresAt());
        return data;
    }

    /**
     * 构建单个状态效果的快照数据，字段与前端 StatusEffectViewState 对齐。
     */
    private Map<String, Object> buildStatusSnapshot(StatusEffectInstance status) {
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("statusInstanceId", status.getStatusInstanceId());
        data.put("statusId", status.getStatusId());
        data.put("sourceEntityId", status.getSourceEntityId());
        data.put("targetEntityId", status.getTargetEntityId());
        data.put("stacks", status.getStacks());
        data.put("expiresAt", status.getExpiresAt());
        if (status.getCreatedAt() != null && status.getExpiresAt() != null) {
            data.put("durationMs", status.getExpiresAt() - status.getCreatedAt());
        }
        return data;
    }

    // ==================== 投射物命中处理 ====================

    /**
     * 处理本 Tick 中投射物命中的结果：根据技能定义查找 onImpact 效果链并对命中目标执行。
     */
    private void handleProjectileHits(BattleRoom room, List<ProjectileService.ProjectileHitResult> hitResults) {
        if (hitResults == null || hitResults.isEmpty()) {
            return;
        }
        for (ProjectileService.ProjectileHitResult hitResult : hitResults) {
            ProjectileState proj = hitResult.getProjectile();
            JsonNode impactEffects = resolveProjectileImpactEffects(proj);
            if (impactEffects == null || !impactEffects.isArray() || impactEffects.size() == 0) {
                continue;
            }
            BattleChampionState caster = battleRoomManager.findChampion(proj.getOwnerId()).orElse(null);
            for (BattleChampionState target : hitResult.getHitTargets()) {
                executeImpactEffectsOnTarget(caster, target, proj, impactEffects);
            }
        }
    }

    /**
     * 根据投射物的 skillId + variantId 反查技能定义中的 onImpact 效果链。
     */
    private JsonNode resolveProjectileImpactEffects(ProjectileState proj) {
        if (proj.getSkillId() == null || proj.getOwnerId() == null) {
            return null;
        }
        /* 需要知道施法者的 heroId 来查找技能定义 */
        BattleChampionState caster = battleRoomManager.findChampion(proj.getOwnerId()).orElse(null);
        if (caster == null) {
            return null;
        }
        JsonNode skillDef = heroSkillDefinitionService.findSkillById(caster.getHeroId(), proj.getSkillId());
        if (skillDef == null || skillDef.isMissingNode()) {
            return null;
        }
        /* 如果有变体 ID，优先使用变体的 effects.onImpact */
        if (proj.getVariantId() != null && !proj.getVariantId().isEmpty()) {
            JsonNode variants = skillDef.path("variants");
            if (variants.isArray()) {
                for (JsonNode variant : variants) {
                    if (proj.getVariantId().equals(variant.path("variantId").asText())) {
                        JsonNode variantImpact = variant.path("effects").path("onImpact");
                        if (variantImpact.isArray() && variantImpact.size() > 0) {
                            return variantImpact;
                        }
                    }
                }
            }
        }
        /* 回退到主技能的 effects.onImpact */
        return skillDef.path("effects").path("onImpact");
    }

    /**
     * 对单个命中目标执行一组 onImpact 效果原子。
     */
    private void executeImpactEffectsOnTarget(BattleChampionState caster, BattleChampionState target,
                                              ProjectileState projectile, JsonNode effects) {
        if (effects == null || !effects.isArray()) {
            return;
        }
        for (JsonNode effect : effects) {
            String type = effect.path("type").asText("");
            String sourceEntityId = caster != null ? caster.getId() : projectile.getOwnerId();
            String castInstanceId = projectile.getCastInstanceId();
            String skillId = projectile.getSkillId();
            switch (type) {
                case "Damage":
                    double base = effect.path("base").asDouble(0);
                    double bonusAdRatio = effect.path("bonusAdRatio").asDouble(0);
                    double apRatio = effect.path("apRatio").asDouble(0);
                    double totalDamage = base + bonusAdRatio * 65 + apRatio * 50;
                    effectAtomicExecutor.applyDamage(sourceEntityId, castInstanceId, skillId, null, target, totalDamage);
                    break;
                case "Knockup":
                    long knockupDuration = effect.path("durationMs").asLong(750);
                    String knockupStatusId = effect.path("statusId").asText("airborne");
                    effectAtomicExecutor.applyStatus(castInstanceId, skillId, null,
                            sourceEntityId, target.getId(), knockupStatusId, knockupDuration, 1);
                    break;
                case "ApplyBuff":
                    String buffStatusId = effect.path("statusId").asText();
                    long buffDuration = effect.path("durationMs").asLong(3000);
                    int stacks = effect.path("stacks").asInt(1);
                    String buffTarget = effect.path("target").asText("hit_target");
                    String targetId = "self".equals(buffTarget) && caster != null ? caster.getId() : target.getId();
                    effectAtomicExecutor.applyStatus(castInstanceId, skillId, null,
                            sourceEntityId, targetId, buffStatusId, buffDuration, stacks);
                    break;
                case "RemoveBuff":
                    String removeStatusId = effect.path("statusId").asText();
                    String removeTargetId = caster != null ? caster.getId() : target.getId();
                    effectAtomicExecutor.removeStatus(castInstanceId, skillId, null, removeTargetId, removeStatusId);
                    break;
                case "Heal":
                    double healAmount = effect.path("base").asDouble(0);
                    effectAtomicExecutor.applyHeal(sourceEntityId, castInstanceId, skillId, null, target, healAmount);
                    break;
                default:
                    log.debug("投射物命中效果暂不支持: type={}", type);
                    break;
            }
        }
    }

    // ==================== Tick 推进方法 ====================

    /**
     * 推进英雄移动，同时累积流值（被动系统）。
     */
    private void advanceMovement(BattleChampionState champion, double delta) {
        if (champion.getMoveTarget() == null || champion.getPosition() == null || (champion.getDead() != null && champion.getDead())) {
            /* 兜底修正：moveTarget 已为 null 但 animationState 残留 run 时，强制纠正为 idle，
             * 防止快照广播出不一致状态导致前端动画抽搐 */
            if (champion.getMoveTarget() == null && "run".equals(champion.getAnimationState())) {
                champion.setAnimationState("idle");
                champion.setIdleStartedAt(System.currentTimeMillis());
            }
            return;
        }
        long now = System.currentTimeMillis();
        if (champion.getMovementLockedUntil() != null && champion.getMovementLockedUntil() > now) {
            return;
        }
        double speed = champion.getMoveSpeed() != null ? champion.getMoveSpeed() : 5.0;
        BattleVector3 pos = champion.getPosition();
        BattleVector3 target = champion.getMoveTarget();
        double dx = target.getX() - pos.getX();
        double dz = target.getZ() - pos.getZ();
        double dist = Math.sqrt(dx * dx + dz * dz);
        double stepSize = speed * delta;
        double actualMoveDistance;
        if (dist <= stepSize) {
            actualMoveDistance = dist;
            pos.setX(target.getX());
            pos.setZ(target.getZ());
            champion.setMoveTarget(null);
            champion.setAnimationState("idle");
            champion.setIdleStartedAt(now);
        } else {
            actualMoveDistance = stepSize;
            pos.setX(pos.getX() + (dx / dist) * stepSize);
            pos.setZ(pos.getZ() + (dz / dist) * stepSize);
            champion.setRotation(Math.atan2(dx, dz));
            champion.setAnimationState("run");
        }
        /* ---------- 建筑碰撞检测与推出 ---------- */
        resolveStructureCollision(pos);

        /* ---------- 被动流值累积 ---------- */
        accumulateFlowValue(champion, actualMoveDistance);
    }

    /**
     * 建筑碰撞检测：如果英雄位置与任何建筑碰撞体重叠，则将英雄推出到碰撞体边缘。
     * 使用简单的圆-圆碰撞模型（英雄半径 + 建筑半径）。
     */
    private void resolveStructureCollision(BattleVector3 pos) {
        for (double[] collider : STRUCTURE_COLLIDERS) {
            double cx = collider[0];
            double cz = collider[1];
            double structureRadius = collider[2];
            double minDist = structureRadius + CHAMPION_COLLISION_RADIUS;

            double dx = pos.getX() - cx;
            double dz = pos.getZ() - cz;
            double distSq = dx * dx + dz * dz;
            double minDistSq = minDist * minDist;

            if (distSq < minDistSq && distSq > 1e-8) {
                /* 英雄与建筑重叠，沿径向推出到碰撞体边缘 */
                double dist = Math.sqrt(distSq);
                double pushFactor = minDist / dist;
                pos.setX(cx + dx * pushFactor);
                pos.setZ(cz + dz * pushFactor);
            } else if (distSq <= 1e-8) {
                /* 极端情况：英雄正好在建筑中心，向 +X 方向推出 */
                pos.setX(cx + minDist);
            }
        }
    }

    /**
     * 累积英雄被动流值。
     * 按亚索被动规则：每移动 1 单位距离累积 movePerUnit 点流值（默认 1.2），
     * 满 100 时自动施加护盾状态并重置流值。
     * 通用英雄如果不配置被动流值则不处理。
     */
    private void accumulateFlowValue(BattleChampionState champion, double moveDistance) {
        if (moveDistance <= 0D || champion.getFlowValue() == null) {
            return;
        }
        /* 读取英雄被动流值配置 */
        JsonNode passives = getHeroPassiveNode(champion.getHeroId());
        if (passives == null) {
            return;
        }
        JsonNode flowConfig = passives.path("flow");
        if (!flowConfig.path("enabled").asBoolean(false)) {
            return;
        }
        double movePerUnit = flowConfig.path("gainRules").path("movePerUnit").asDouble(1.2D);
        double maxValue = flowConfig.path("maxValue").asDouble(100D);
        String shieldStatusId = flowConfig.path("shieldStatusId").asText("yasuo_flow_shield_ready");

        double newFlow = champion.getFlowValue() + moveDistance * movePerUnit;
        if (newFlow >= maxValue) {
            newFlow = 0D;
            /* 施加护盾状态，表示被动已满可触发 */
            if (!statusEffectService.hasStatus(champion.getId(), shieldStatusId)) {
                double shieldBase = flowConfig.path("shieldValueFormula").path("base").asDouble(110D);
                effectAtomicExecutor.applyShield(champion, shieldBase);
                effectAtomicExecutor.applyStatus(shieldStatusId, champion.getId(), champion, 1, 3000L);
                log.debug("亚索被动流值满，施加护盾: championId={}, shield={}", champion.getId(), shieldBase);
            }
        }
        champion.setFlowValue(newFlow);
    }

    /**
     * 广播投射物销毁事件。
     */
    private void broadcastProjectileDestroyed(BattleRoom room,
                                             List<ProjectileService.ProjectileDestroyedResult> destroyedResults,
                                             long now) {
        if (destroyedResults == null || destroyedResults.isEmpty()) {
            return;
        }
        for (ProjectileService.ProjectileDestroyedResult destroyedResult : destroyedResults) {
            ProjectileState projectile = destroyedResult.getProjectile();
            Map<String, Object> fields = new LinkedHashMap<String, Object>();
            fields.put("castInstanceId", projectile.getCastInstanceId());
            fields.put("skillId", projectile.getSkillId());
            fields.put("ownerId", projectile.getOwnerId());
            fields.put("projectileId", projectile.getProjectileId());
            fields.put("destroyReason", destroyedResult.getDestroyReason());
            fields.put("position", projectile.getPosition());
            if (destroyedResult.getHitTargets() != null && !destroyedResult.getHitTargets().isEmpty()) {
                List<String> hitTargetIds = new ArrayList<String>();
                for (BattleChampionState target : destroyedResult.getHitTargets()) {
                    hitTargetIds.add(target.getId());
                }
                fields.put("hitTargetIds", hitTargetIds);
            }
            battleBroadcastService.broadcastCombatEvent(room, "projectileDestroyed", "projectile-destroyed", now, fields);
        }
    }

    /**
     * 广播区域体过期事件。
     */
    private void broadcastAreaExpired(BattleRoom room, List<AreaEffectState> expiredAreas, long now) {
        if (expiredAreas == null || expiredAreas.isEmpty()) {
            return;
        }
        for (AreaEffectState area : expiredAreas) {
            Map<String, Object> fields = new LinkedHashMap<String, Object>();
            fields.put("castInstanceId", area.getCastInstanceId());
            fields.put("skillId", area.getSkillId());
            fields.put("ownerId", area.getOwnerId());
            fields.put("areaId", area.getAreaId());
            fields.put("areaType", area.getAreaType());
            fields.put("position", area.getPosition());
            fields.put("reason", "expired");
            battleBroadcastService.broadcastCombatEvent(room, "areaExpired", "area-expired", now, fields);
        }
    }

    /**
     * 广播状态移除事件。
     */
    private void broadcastStatusRemoved(BattleRoom room, List<StatusEffectInstance> removedStatuses, long now, String reason) {
        if (removedStatuses == null || removedStatuses.isEmpty()) {
            return;
        }
        for (StatusEffectInstance status : removedStatuses) {
            Map<String, Object> fields = new LinkedHashMap<String, Object>();
            fields.put("statusInstanceId", status.getStatusInstanceId());
            fields.put("statusId", status.getStatusId());
            fields.put("sourceEntityId", status.getSourceEntityId());
            fields.put("targetEntityId", status.getTargetEntityId());
            fields.put("stacks", status.getStacks());
            fields.put("reason", reason);
            battleBroadcastService.broadcastCombatEvent(room, "StatusRemoved", "status-removed", now, fields);
        }
    }

    /**
     * 获取英雄被动技能定义节点。
     */
    private JsonNode getHeroPassiveNode(String heroId) {
        if (heroId == null) {
            return null;
        }
        try {
            /* 查找 passives 数组中 slot=passive 的第一个定义 */
            JsonNode allSkills = heroSkillDefinitionService.getAllSkillsByHeroId(heroId);
            if (allSkills != null && allSkills.has("passives")) {
                JsonNode passives = allSkills.path("passives");
                if (passives.isArray() && passives.size() > 0) {
                    return passives.get(0);
                }
            }
        } catch (Exception e) {
            /* 静默忽略，非亚索英雄可能没有被动流值配置 */
        }
        return null;
    }

    /**
     * 推进英雄技能冷却递减。
     * 每 Tick 减少所有技能的 remainingCooldownMs，归零后标记 isReady。
     */
    private void advanceCooldowns(BattleChampionState champion, long tickIntervalMs) {
        Map<String, Map<String, Object>> skillStates = champion.getSkillStates();
        if (skillStates == null) {
            return;
        }
        for (Map<String, Object> slotState : skillStates.values()) {
            Object remainingObj = slotState.get("remainingCooldownMs");
            if (remainingObj instanceof Number) {
                long remaining = ((Number) remainingObj).longValue();
                if (remaining > 0L) {
                    remaining = Math.max(0L, remaining - tickIntervalMs);
                    slotState.put("remainingCooldownMs", remaining);
                    if (remaining <= 0L) {
                        slotState.put("isReady", Boolean.TRUE);
                    }
                }
            }
        }
    }
}

