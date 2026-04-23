package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.ActiveSpellInstance;
import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleRoom;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import com.cong.battle3ddemoserver.battle.model.CastValidationResult;
import com.cong.battle3ddemoserver.battle.model.SpellCastRequest;
import com.cong.battle3ddemoserver.battle.model.SpellStageTransition;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 技能生命周期服务。
 * 负责技能实例从 windup -> resolve -> finished 的完整阶段推进，
 * 在 resolve 阶段执行效果原子链（伤害、Buff、投射物、区域体等），
 * 在 create 阶段扣除资源并设置施法锁定，在 finished 阶段启动冷却。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SpellLifecycleService {
    private final BattleRoomManager battleRoomManager;
    private final HeroSkillDefinitionService heroSkillDefinitionService;
    private final SpellCastValidationService spellCastValidationService;
    private final EffectAtomicExecutor effectAtomicExecutor;
    private final HitResolutionService hitResolutionService;
    private final StatusEffectService statusEffectService;

    /** 当前房间内所有活跃技能实例。 */
    private final List<ActiveSpellInstance> activeSpellInstances = new CopyOnWriteArrayList<ActiveSpellInstance>();

    /**
     * 校验施法请求合法性。
     */
    public CastValidationResult validate(SpellCastRequest request) {
        return spellCastValidationService.validate(request);
    }

    /**
     * 创建技能实例，扣除资源，设置施法锁定与英雄施法状态。
     */
    public ActiveSpellInstance create(SpellCastRequest request) {
        BattleChampionState caster = battleRoomManager.findChampion(request.getCasterId()).orElse(null);
        if (caster == null) {
            throw new IllegalStateException("施法者不存在，无法创建技能实例");
        }
        JsonNode skillDefinition = resolveSkillDefinition(caster.getHeroId(), request.getSkillId(), request.getSlot());
        long now = System.currentTimeMillis();
        long castTimeMs = skillDefinition.path("cast").path("castTimeMs").asLong(0L);
        long backswingMs = skillDefinition.path("cast").path("backswingMs").asLong(0L);
        boolean lockMovement = skillDefinition.path("cast").path("lockMovement").asBoolean(true);
        BattleRoom room = battleRoomManager.getRoom();

        /* ---------- 扣除资源 ---------- */
        deductCastCost(caster, skillDefinition);

        /* ---------- 创建技能实例 ---------- */
        ActiveSpellInstance instance = ActiveSpellInstance.builder()
                .castInstanceId("cast-" + UUID.randomUUID().toString())
                .requestId(request.getRequestId())
                .roomId(room.getRoomId())
                .casterId(request.getCasterId())
                .skillId(skillDefinition.path("skillId").asText())
                .slot(skillDefinition.path("slot").asText())
                .stage("windup")
                .targetEntityId(request.getTargetEntityId())
                .targetPoint(request.getTargetPoint())
                .createdAt(now)
                .stageStartedAt(now)
                .expectedResolveAt(now + castTimeMs)
                .build();
        activeSpellInstances.add(instance);

        /* ---------- 设置施法者状态 ---------- */
        caster.setActiveCastInstanceId(instance.getCastInstanceId());
        caster.setActiveCastPhase("windup");
        if (lockMovement) {
            caster.setMovementLockedUntil(now + castTimeMs + backswingMs);
            caster.setMoveTarget(null);
        }
        /* 更新技能槽位为施法中 */
        updateSkillSlotCasting(caster, instance.getSlot(), true);

        log.info("技能实例已创建: castInstanceId={}, skillId={}, casterId={}, stage=windup",
                instance.getCastInstanceId(), instance.getSkillId(), instance.getCasterId());
        return instance;
    }

    /**
     * 获取当前所有活跃技能实例。
     */
    public List<ActiveSpellInstance> getActiveSpellInstances() {
        return activeSpellInstances;
    }

    /**
     * 每 Tick 推进所有活跃技能实例的阶段，返回本次产生的所有阶段切换记录。
     */
    public List<SpellStageTransition> advance(long now) {
        List<SpellStageTransition> transitions = new ArrayList<SpellStageTransition>();
        for (ActiveSpellInstance instance : activeSpellInstances) {
            try {
                /* windup -> resolve：前摇结束，触发效果执行 */
                if ("windup".equals(instance.getStage()) && now >= instance.getExpectedResolveAt()) {
                    transitions.add(changeStage(instance, "resolve", now));
                    executeResolveEffects(instance);
                    continue;
                }
                /* resolve -> finished：效果执行完毕，进入收尾 */
                if ("resolve".equals(instance.getStage()) && now >= instance.getStageStartedAt() + 50L) {
                    transitions.add(changeStage(instance, "finished", now));
                    onSpellFinished(instance);
                }
            } catch (Exception e) {
                log.error("技能阶段推进异常: castInstanceId={}, skillId={}, stage={}",
                        instance.getCastInstanceId(), instance.getSkillId(), instance.getStage(), e);
                /* 异常时强制标记为 finished，避免实例永久卡住 */
                instance.setStage("finished");
            }
        }
        activeSpellInstances.removeIf(instance -> "finished".equals(instance.getStage()));
        return transitions;
    }

    // ==================== 内部方法 ====================

    /**
     * 解析技能定义：优先按 skillId 查找，其次按 slot 查找。
     */
    private JsonNode resolveSkillDefinition(String heroId, String skillId, String slot) {
        if (skillId != null && !skillId.trim().isEmpty()) {
            JsonNode result = heroSkillDefinitionService.findSkillById(heroId, skillId);
            if (result != null && !result.isMissingNode()) {
                return result;
            }
        }
        return heroSkillDefinitionService.findSkillBySlot(heroId, slot);
    }

    /**
     * 扣除施法资源消耗（法力值等）。
     */
    private void deductCastCost(BattleChampionState caster, JsonNode skillDefinition) {
        JsonNode cost = skillDefinition.path("cost");
        String resourceType = cost.path("resourceType").asText("none");
        double amount = cost.path("amount").asDouble(0D);
        if ("mana".equals(resourceType) && amount > 0D && caster.getMp() != null) {
            caster.setMp(Math.max(0D, caster.getMp() - amount));
        }
    }

    /**
     * resolve 阶段：执行技能效果原子链。
     * 依次处理 effects.onActivate 和 effects.onImpact 中配置的效果原子。
     * 如果技能定义中包含 variants，会先检查是否满足变体条件，满足则使用变体效果链。
     */
    private void executeResolveEffects(ActiveSpellInstance instance) {
        BattleChampionState caster = battleRoomManager.findChampion(instance.getCasterId()).orElse(null);
        if (caster == null) {
            return;
        }
        JsonNode skillDefinition = resolveSkillDefinition(caster.getHeroId(), instance.getSkillId(), instance.getSlot());
        if (skillDefinition == null || skillDefinition.isMissingNode()) {
            return;
        }

        /* ---------- 变体检测 ---------- */
        String activeVariantId = null;
        JsonNode effects = skillDefinition.path("effects");
        JsonNode variants = skillDefinition.path("variants");
        String castType = skillDefinition.path("cast").path("type").asText("");
        BattleChampionState resolvedCastTarget = resolveTarget(instance);
        if (variants.isArray()) {
            for (JsonNode variant : variants) {
                if (checkVariantCondition(variant, caster)) {
                    activeVariantId = variant.path("variantId").asText(null);
                    JsonNode variantEffects = variant.path("effects");
                    if (!variantEffects.isMissingNode()) {
                        effects = variantEffects;
                    }
                    log.info("技能变体触发: skillId={}, variantId={}, casterId={}",
                            instance.getSkillId(), activeVariantId, caster.getId());
                    break;
                }
            }
        }

        /* 将变体 ID 保存到实例中，用于后续投射物生成时传递 */
        String effectVariantId = activeVariantId;

        /* 执行 onActivate 效果（自身 Buff、位移、投射物/区域体生成等） */
        executeEffectList(
                effects.path("onActivate"),
                instance,
                caster,
                "target_unit".equals(castType) ? resolvedCastTarget : null,
                effectVariantId);

        /* 执行 onImpact 效果 */
        if ("directional".equals(castType) || "line".equals(castType)) {
            /* 方向性/线性技能：做范围命中判定 */
            double range = skillDefinition.path("cast").path("range").asDouble(8D);
            double width = skillDefinition.path("cast").path("width").asDouble(1.1D);
            BattleVector3 direction = calculateProjectileDirection(caster, instance);
            List<BattleChampionState> hitTargets = hitResolutionService.findTargetsInLine(
                    caster.getPosition(), direction, range, width, caster.getId());
            /* 过滤只命中敌方 */
            hitTargets.removeIf(t -> caster.getTeam() != null && caster.getTeam().equals(t.getTeam()));
            for (BattleChampionState target : hitTargets) {
                executeEffectList(effects.path("onImpact"), instance, caster, target, effectVariantId);
            }
        } else if ("target_point".equals(castType) && skillDefinition.path("cast").has("radius")) {
            /* 目标点 + 半径的范围技能（如 R 技能模板） */
            double radius = skillDefinition.path("cast").path("radius").asDouble(3D);
            BattleVector3 center = instance.getTargetPoint() != null ? instance.getTargetPoint() : caster.getPosition();
            List<BattleChampionState> hitTargets = hitResolutionService.findTargetsInRadius(center, radius);
            hitTargets.removeIf(t -> caster.getTeam() != null && caster.getTeam().equals(t.getTeam()));
            for (BattleChampionState target : hitTargets) {
                executeEffectList(effects.path("onImpact"), instance, caster, target, effectVariantId);
            }
        } else {
            /* 单体目标技能 */
            BattleChampionState target = resolvedCastTarget;
            executeEffectList(effects.path("onImpact"), instance, caster, target, effectVariantId);
        }

        /* 执行 onSuccessCast 效果（施法成功后的叠层等） */
        executeEffectList(effects.path("onSuccessCast"), instance, caster, null, effectVariantId);

        /* 更新施法者阶段状态 */
        caster.setActiveCastPhase("resolve");
        log.debug("技能效果已执行: castInstanceId={}, skillId={}, variantId={}",
                instance.getCastInstanceId(), instance.getSkillId(), activeVariantId);
    }

    /**
     * 检查技能变体条件是否满足。
     * 当前支持：要求施法者拥有指定状态且层数 >= minStacks。
     */
    private boolean checkVariantCondition(JsonNode variant, BattleChampionState caster) {
        JsonNode condition = variant.path("condition");
        if (condition.isMissingNode()) {
            return false;
        }
        String requiresStatusId = condition.path("requiresStatusId").asText(null);
        if (requiresStatusId == null) {
            return false;
        }
        int minStacks = condition.path("minStacks").asInt(1);
        int currentStacks = statusEffectService.getStacks(caster.getId(), requiresStatusId);
        return currentStacks >= minStacks;
    }

    /**
     * 遍历并执行一组效果原子配置。
     */
    private void executeEffectList(JsonNode effectList, ActiveSpellInstance instance,
                                    BattleChampionState caster, BattleChampionState defaultTarget,
                                    String variantId) {
        if (effectList == null || !effectList.isArray()) {
            return;
        }
        for (JsonNode effectNode : effectList) {
            String effectType = effectNode.path("type").asText("");
            /* 根据 target 字段决定实际目标 */
            BattleChampionState effectTarget = resolveEffectTarget(effectNode, caster, defaultTarget);
            executeEffectAtom(effectType, effectNode, instance, caster, effectTarget, variantId);
        }
    }

    /**
     * 根据效果原子类型分发执行。
     */
    private void executeEffectAtom(String effectType, JsonNode effectNode, ActiveSpellInstance instance,
                                    BattleChampionState caster, BattleChampionState target, String variantId) {
        switch (effectType) {
            case "Damage":
                executeDamage(effectNode, instance, caster, target);
                break;
            case "Heal":
                executeHeal(effectNode, instance, target != null ? target : caster);
                break;
            case "ApplyBuff":
                executeApplyBuff(effectNode, instance, caster, target);
                break;
            case "RemoveBuff":
                executeRemoveBuff(effectNode, instance, caster, target);
                break;
            case "Shield":
                executeShield(effectNode, instance, caster, target);
                break;
            case "SpawnProjectile":
                executeSpawnProjectile(effectNode, instance, caster, variantId);
                break;
            case "SpawnTerrain":
                executeSpawnTerrain(effectNode, instance, caster);
                break;
            case "Dash":
                executeDash(effectNode, caster, target, instance);
                break;
            case "Knockup":
                executeKnockup(effectNode, instance, caster, target);
                break;
            case "Teleport":
                executeTeleport(effectNode, caster, target);
                break;
            default:
                log.warn("未识别的效果原子类型: {}, castInstanceId={}", effectType, instance.getCastInstanceId());
        }
    }

    // ==================== 效果原子执行方法 ====================

    /**
     * 执行伤害效果原子。
     * 当前阶段使用基础伤害值，后续扩展 AD/AP 系数计算。
     */
    private void executeDamage(JsonNode effectNode, ActiveSpellInstance instance,
                               BattleChampionState caster, BattleChampionState target) {
        if (target == null) {
            return;
        }
        double baseDamage = effectNode.path("base").asDouble(0D);
        effectAtomicExecutor.applyDamage(caster.getId(), instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(), target, baseDamage);
    }

    /**
     * 执行治疗效果原子。
     */
    private void executeHeal(JsonNode effectNode, ActiveSpellInstance instance, BattleChampionState target) {
        if (target == null) {
            return;
        }
        double baseHeal = effectNode.path("base").asDouble(0D);
        effectAtomicExecutor.applyHeal(instance.getCasterId(), instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(), target, baseHeal);
    }

    /**
     * 执行施加 Buff/Debuff 效果原子。
     */
    private void executeApplyBuff(JsonNode effectNode, ActiveSpellInstance instance,
                                   BattleChampionState caster, BattleChampionState defaultTarget) {
        String statusId = effectNode.path("statusId").asText(null);
        if (statusId == null) {
            return;
        }
        long durationMs = effectNode.path("durationMs").asLong(0L);
        int stacks = effectNode.path("stacks").asInt(1);
        String targetType = effectNode.path("target").asText("");
        BattleChampionState actualTarget = "self".equals(targetType) ? caster : defaultTarget;
        if (actualTarget == null) {
            actualTarget = caster;
        }
        effectAtomicExecutor.applyStatus(instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(),
                statusId, caster.getId(), actualTarget, stacks, durationMs);
    }

    /**
     * 执行移除 Buff 效果原子。
     */
    private void executeRemoveBuff(JsonNode effectNode, ActiveSpellInstance instance,
                                   BattleChampionState caster, BattleChampionState target) {
        String statusId = effectNode.path("statusId").asText(null);
        if (statusId == null) {
            return;
        }
        boolean removeAllStacks = effectNode.path("removeAllStacks").asBoolean(false);
        String targetType = effectNode.path("target").asText("");
        BattleChampionState actualTarget = "self".equals(targetType) || target == null ? caster : target;
        effectAtomicExecutor.removeStatus(instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(),
                statusId, actualTarget, removeAllStacks);
    }

    /**
     * 执行护盾效果原子。
     */
    private void executeShield(JsonNode effectNode, ActiveSpellInstance instance,
                               BattleChampionState caster, BattleChampionState target) {
        double shieldValue = effectNode.path("base").asDouble(0D);
        String targetType = effectNode.path("target").asText("");
        BattleChampionState actualTarget = "self".equals(targetType) || target == null ? caster : target;
        effectAtomicExecutor.applyShield(caster.getId(), instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(), actualTarget, shieldValue);
    }

    /**
     * 执行投射物生成效果原子。
     */
    private void executeSpawnProjectile(JsonNode effectNode, ActiveSpellInstance instance,
                                         BattleChampionState caster, String variantId) {
        double speed = effectNode.path("speed").asDouble(15D);
        double maxDistance = effectNode.path("maxDistance").asDouble(10D);
        double radius = effectNode.path("radius").asDouble(0.5D);
        boolean blockable = effectNode.path("blockable").asBoolean(false);
        long lifetimeMs = (long) (maxDistance / speed * 1000D) + 500L;

        /* 计算投射物初始方向 */
        BattleVector3 direction = calculateProjectileDirection(caster, instance);
        effectAtomicExecutor.spawnProjectile(
                instance.getCastInstanceId(), caster.getId(), instance.getSkillId(),
                clonePosition(caster.getPosition()), direction, speed, radius, blockable, lifetimeMs,
                caster.getTeam(), variantId);
    }

    /**
     * 执行地形/区域体生成效果原子（如亚索风墙）。
     */
    private void executeSpawnTerrain(JsonNode effectNode, ActiveSpellInstance instance, BattleChampionState caster) {
        String terrainType = effectNode.path("terrainType").asText("generic");
        long durationMs = effectNode.path("durationMs").asLong(4000L);
        double length = effectNode.path("length").asDouble(5D);
        double thickness = effectNode.path("thickness").asDouble(0.6D);
        double height = effectNode.path("height").asDouble(4D);
        double radius = effectNode.path("radius").asDouble(0D);

        /* 区域体生成在施法者前方 */
        BattleVector3 spawnPosition = calculateFrontPosition(caster, 2.5D);
        effectAtomicExecutor.spawnArea(
                instance.getCastInstanceId(), caster.getId(), instance.getSkillId(),
                terrainType, spawnPosition, radius, caster.getRotation(), length, thickness, height, durationMs);
    }

    /**
     * 执行位移（冲刺）效果原子。
     */
    private void executeDash(JsonNode effectNode, BattleChampionState caster,
                              BattleChampionState target, ActiveSpellInstance instance) {
        String dashType = effectNode.path("dashType").asText("towards_point");
        double speed = effectNode.path("speed").asDouble(18D);
        double maxDistance = effectNode.path("maxDistance").asDouble(7D);
        long dashDurationMs = (long) (maxDistance / speed * 1000D);

        BattleVector3 dashTarget;
        if ("through_target".equals(dashType) && target != null && target.getPosition() != null) {
            /* 穿越目标式冲刺（如亚索 E） */
            double offsetBehind = effectNode.path("distanceOffset").asDouble(1.4D);
            dashTarget = calculateBehindTargetPosition(caster, target, offsetBehind);
        } else if (instance.getTargetPoint() != null) {
            /* 向目标点冲刺 */
            dashTarget = instance.getTargetPoint();
        } else {
            /* 向当前朝向冲刺 */
            dashTarget = calculateFrontPosition(caster, maxDistance);
        }
        caster.setMoveTarget(dashTarget);
        caster.setMovementLockedUntil(System.currentTimeMillis() + dashDurationMs);
    }

    /**
     * 执行击飞效果原子。
     */
    private void executeKnockup(JsonNode effectNode, ActiveSpellInstance instance,
                                BattleChampionState caster, BattleChampionState target) {
        if (target == null) {
            return;
        }
        long durationMs = effectNode.path("durationMs").asLong(900L);
        String statusId = effectNode.path("statusId").asText("airborne");
        effectAtomicExecutor.applyStatus(instance.getCastInstanceId(), instance.getSkillId(), instance.getSlot(),
                statusId, caster.getId(), target, 1, durationMs);
        /* 击飞期间锁定目标移动 */
        target.setMovementLockedUntil(System.currentTimeMillis() + durationMs);
        target.setMoveTarget(null);
    }

    /**
     * 执行瞬移效果原子。
     */
    private void executeTeleport(JsonNode effectNode, BattleChampionState caster, BattleChampionState target) {
        String teleportType = effectNode.path("teleportType").asText("");
        if ("relative_to_target".equals(teleportType) && target != null && target.getPosition() != null) {
            double offsetBehind = effectNode.path("offsetBehindTarget").asDouble(1.2D);
            BattleVector3 teleportPos = calculateBehindTargetPosition(caster, target, offsetBehind);
            caster.setPosition(teleportPos);
        }
    }

    // ==================== 阶段管理辅助方法 ====================

    /**
     * 技能实例进入 finished 阶段时的收尾处理：启动冷却、重置施法者状态。
     */
    private void onSpellFinished(ActiveSpellInstance instance) {
        BattleChampionState caster = battleRoomManager.findChampion(instance.getCasterId()).orElse(null);
        if (caster == null) {
            return;
        }
        /* 重置施法者施法状态 */
        caster.setActiveCastInstanceId(null);
        caster.setActiveCastPhase("idle");
        updateSkillSlotCasting(caster, instance.getSlot(), false);

        /* 启动冷却 */
        startCooldown(caster, instance);
    }

    /**
     * 启动技能冷却。
     */
    private void startCooldown(BattleChampionState caster, ActiveSpellInstance instance) {
        Map<String, Map<String, Object>> skillStates = caster.getSkillStates();
        if (skillStates == null) {
            return;
        }
        Map<String, Object> slotState = skillStates.get(instance.getSlot());
        if (slotState == null) {
            return;
        }
        Object maxCdObj = slotState.get("maxCooldownMs");
        long maxCooldownMs = 0L;
        if (maxCdObj instanceof Number) {
            maxCooldownMs = ((Number) maxCdObj).longValue();
        }
        if (maxCooldownMs > 0L) {
            slotState.put("remainingCooldownMs", maxCooldownMs);
            slotState.put("isReady", Boolean.FALSE);
        }
    }

    /**
     * 更新技能槽位的 isCasting 状态。
     */
    private void updateSkillSlotCasting(BattleChampionState caster, String slot, boolean isCasting) {
        Map<String, Map<String, Object>> skillStates = caster.getSkillStates();
        if (skillStates == null) {
            return;
        }
        Map<String, Object> slotState = skillStates.get(slot);
        if (slotState != null) {
            slotState.put("isCasting", isCasting);
        }
    }

    /**
     * 切换技能实例阶段，返回阶段切换记录。
     */
    private SpellStageTransition changeStage(ActiveSpellInstance instance, String nextStage, long now) {
        String previousStage = instance.getStage();
        instance.setStage(nextStage);
        instance.setStageStartedAt(now);
        return SpellStageTransition.builder()
                .castInstanceId(instance.getCastInstanceId())
                .casterId(instance.getCasterId())
                .skillId(instance.getSkillId())
                .slot(instance.getSlot())
                .targetEntityId(instance.getTargetEntityId())
                .targetPoint(instance.getTargetPoint())
                .previousStage(previousStage)
                .nextStage(nextStage)
                .build();
    }

    // ==================== 空间计算辅助方法 ====================

    /**
     * 根据施法者朝向或目标点计算投射物飞行方向（单位向量）。
     */
    private BattleVector3 calculateProjectileDirection(BattleChampionState caster, ActiveSpellInstance instance) {
        if (instance.getTargetPoint() != null && caster.getPosition() != null) {
            double dx = instance.getTargetPoint().getX() - caster.getPosition().getX();
            double dz = instance.getTargetPoint().getZ() - caster.getPosition().getZ();
            double dist = Math.hypot(dx, dz);
            if (dist > 0.01D) {
                return BattleVector3.builder().x(dx / dist).y(0D).z(dz / dist).build();
            }
        }
        /* 默认使用施法者当前朝向 */
        double rotation = caster.getRotation() != null ? caster.getRotation() : 0D;
        return BattleVector3.builder()
                .x(Math.sin(rotation))
                .y(0D)
                .z(Math.cos(rotation))
                .build();
    }

    /**
     * 计算施法者前方指定距离的坐标。
     */
    private BattleVector3 calculateFrontPosition(BattleChampionState caster, double distance) {
        double rotation = caster.getRotation() != null ? caster.getRotation() : 0D;
        return BattleVector3.builder()
                .x(caster.getPosition().getX() + Math.sin(rotation) * distance)
                .y(0D)
                .z(caster.getPosition().getZ() + Math.cos(rotation) * distance)
                .build();
    }

    /**
     * 计算目标身后指定偏移距离的坐标（穿越式冲刺/传送使用）。
     */
    private BattleVector3 calculateBehindTargetPosition(BattleChampionState caster, BattleChampionState target, double offset) {
        double dx = target.getPosition().getX() - caster.getPosition().getX();
        double dz = target.getPosition().getZ() - caster.getPosition().getZ();
        double dist = Math.hypot(dx, dz);
        if (dist < 0.01D) {
            return clonePosition(target.getPosition());
        }
        double dirX = dx / dist;
        double dirZ = dz / dist;
        return BattleVector3.builder()
                .x(target.getPosition().getX() + dirX * offset)
                .y(0D)
                .z(target.getPosition().getZ() + dirZ * offset)
                .build();
    }

    /**
     * 解析效果目标实体。
     */
    private BattleChampionState resolveTarget(ActiveSpellInstance instance) {
        if (instance.getTargetEntityId() != null && !instance.getTargetEntityId().trim().isEmpty()) {
            return battleRoomManager.findChampion(instance.getTargetEntityId()).orElse(null);
        }
        return null;
    }

    /**
     * 根据效果配置中的 target 字段解析实际目标。
     */
    private BattleChampionState resolveEffectTarget(JsonNode effectNode, BattleChampionState caster,
                                                      BattleChampionState defaultTarget) {
        String targetType = effectNode.path("target").asText("");
        if ("self".equals(targetType)) {
            return caster;
        }
        if ("hit_target".equals(targetType) && defaultTarget != null) {
            return defaultTarget;
        }
        return defaultTarget;
    }

    /**
     * 复制坐标（避免引用共享导致的数据污染）。
     */
    private BattleVector3 clonePosition(BattleVector3 original) {
        if (original == null) {
            return BattleVector3.builder().x(0D).y(0D).z(0D).build();
        }
        return BattleVector3.builder().x(original.getX()).y(original.getY()).z(original.getZ()).build();
    }
}
