package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.CastValidationResult;
import com.cong.battle3ddemoserver.battle.model.SpellCastRequest;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * 统一施法校验服务。
 * 校验链：请求合法性 -> 施法者存在 -> 死亡状态 -> 控制效果 -> 正在施法中 ->
 *         技能定义存在 -> 冷却中 -> 资源是否足够 -> 目标合法性。
 * 后续再逐步扩展到距离校验、墙体遮挡、击飞窗口与复杂规则。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SpellCastValidationService {
    private final BattleRoomManager battleRoomManager;
    private final HeroSkillDefinitionService heroSkillDefinitionService;
    private final StatusEffectService statusEffectService;

    /**
     * 执行完整施法校验链。
     */
    public CastValidationResult validate(SpellCastRequest request) {
        /* ---------- 1. 请求基础合法性 ---------- */
        if (request == null) {
            return CastValidationResult.fail("invalid_request", "施法请求为空");
        }
        if (request.getCasterId() == null || request.getCasterId().trim().isEmpty()) {
            return CastValidationResult.fail("invalid_caster", "施法者不能为空");
        }

        /* ---------- 2. 施法者存在性 ---------- */
        BattleChampionState caster = battleRoomManager.findChampion(request.getCasterId()).orElse(null);
        if (caster == null) {
            return CastValidationResult.fail("caster_not_found", "施法者不存在");
        }

        /* ---------- 3. 死亡状态检查 ---------- */
        if (caster.getDead() != null && caster.getDead()) {
            return CastValidationResult.fail("caster_dead", "施法者已死亡，无法施法");
        }

        /* ---------- 4. 控制效果检查（眩晕、沉默） ---------- */
        CastValidationResult ccResult = checkControlEffects(caster);
        if (ccResult != null) {
            return ccResult;
        }

        /* ---------- 5. 正在施法中检查 ---------- */
        if (caster.getActiveCastPhase() != null
                && !"idle".equals(caster.getActiveCastPhase())
                && !"finished".equals(caster.getActiveCastPhase())) {
            return CastValidationResult.fail("already_casting", "当前正在施法中，无法释放新技能");
        }

        /* ---------- 6. 技能定义存在性 ---------- */
        JsonNode skillDefinition = resolveSkillDefinition(caster.getHeroId(), request.getSkillId(), request.getSlot());
        if (skillDefinition == null || skillDefinition.isMissingNode()) {
            return CastValidationResult.fail("skill_not_found", "技能定义不存在");
        }

        /* ---------- 7. 技能等级检查（0 级技能不可释放，被动除外） ---------- */
        String slot = skillDefinition.path("slot").asText("");
        if (!"passive".equals(slot) && !"basicAttack".equals(slot)) {
            int skillLevel = getSkillLevel(caster, slot);
            if (skillLevel <= 0) {
                return CastValidationResult.fail("skill_not_learned", "技能尚未学习");
            }
        }

        /* ---------- 8. 冷却中检查 ---------- */
        CastValidationResult cooldownResult = checkCooldown(caster, slot);
        if (cooldownResult != null) {
            return cooldownResult;
        }

        /* ---------- 9. 资源消耗检查 ---------- */
        JsonNode cost = skillDefinition.path("cost");
        String resourceType = cost.path("resourceType").asText("none");
        double amount = cost.path("amount").asDouble(0D);
        if ("mana".equals(resourceType) && caster.getMp() != null && caster.getMp() < amount) {
            return CastValidationResult.fail("insufficient_mana", "法力值不足");
        }

        /* ---------- 10. 目标合法性检查 ---------- */
        JsonNode cast = skillDefinition.path("cast");
        String castType = cast.path("type").asText();
        if ("target_unit".equals(castType) && (request.getTargetEntityId() == null || request.getTargetEntityId().trim().isEmpty())) {
            return CastValidationResult.fail("invalid_target", "该技能需要目标单位");
        }
        if (("target_point".equals(castType) || "directional".equals(castType)) && request.getTargetPoint() == null) {
            return CastValidationResult.fail("invalid_point", "该技能需要目标点");
        }

        /* ---------- 11. 目标单位存活检查 ---------- */
        if ("target_unit".equals(castType) && request.getTargetEntityId() != null) {
            BattleChampionState target = battleRoomManager.findChampion(request.getTargetEntityId()).orElse(null);
            if (target == null) {
                return CastValidationResult.fail("target_not_found", "目标单位不存在");
            }
            if (target.getDead() != null && target.getDead()) {
                return CastValidationResult.fail("target_dead", "目标单位已死亡");
            }
            CastValidationResult targetRulesResult = checkTargetRules(caster, target, cast.path("targetRules"));
            if (targetRulesResult != null) {
                return targetRulesResult;
            }
        }

        /* ---------- 12. 施法距离校验 ---------- */
        CastValidationResult rangeResult = checkCastRange(caster, request, skillDefinition);
        if (rangeResult != null) {
            return rangeResult;
        }

        return CastValidationResult.success();
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
     * 检查施法者身上的控制效果。
     * 眩晕（stun）：禁止一切施法。
     * 沉默（silence）：禁止技能施法，但允许普攻。
     * 击飞（airborne）：禁止一切施法。
     */
    private CastValidationResult checkControlEffects(BattleChampionState caster) {
        String casterId = caster.getId();
        if (statusEffectService.hasStatus(casterId, "stun")) {
            return CastValidationResult.fail("stunned", "施法者处于眩晕状态，无法施法");
        }
        if (statusEffectService.hasStatus(casterId, "airborne")) {
            return CastValidationResult.fail("airborne", "施法者处于击飞状态，无法施法");
        }
        if (statusEffectService.hasStatus(casterId, "silence")) {
            return CastValidationResult.fail("silenced", "施法者处于沉默状态，无法使用技能");
        }
        if (statusEffectService.hasStatus(casterId, "suppression")) {
            return CastValidationResult.fail("suppressed", "施法者处于压制状态，无法施法");
        }
        return null;
    }

    /**
     * 检查技能是否在冷却中。
     */
    private CastValidationResult checkCooldown(BattleChampionState caster, String slot) {
        Map<String, Map<String, Object>> skillStates = caster.getSkillStates();
        if (skillStates == null) {
            return null;
        }
        Map<String, Object> slotState = skillStates.get(slot);
        if (slotState == null) {
            return null;
        }
        Object remainingCdObj = slotState.get("remainingCooldownMs");
        if (remainingCdObj instanceof Number) {
            long remainingCooldownMs = ((Number) remainingCdObj).longValue();
            if (remainingCooldownMs > 0L) {
                return CastValidationResult.fail("on_cooldown", "技能冷却中，剩余 " + remainingCooldownMs + "ms");
            }
        }
        return null;
    }

    /**
     * 施法距离校验。
     * 对于指向目标单位（target_unit）的技能，检查施法者与目标之间的距离是否在技能允许范围内。
     * 对于指向目标点（target_point）的技能，检查施法者与目标点之间的距离。
     * 如果技能定义中未配置 cast.range，则跳过距离校验（向后兼容）。
     */
    private CastValidationResult checkCastRange(BattleChampionState caster, SpellCastRequest request, JsonNode skillDefinition) {
        JsonNode cast = skillDefinition.path("cast");
        double maxRange = cast.path("range").asDouble(0D);
        /* 未配置施法距离，跳过校验 */
        if (maxRange <= 0D) {
            return null;
        }
        /* 增加少量容差，避免边缘浮点精度问题 */
        double toleranceRange = maxRange + 0.5D;

        String castType = cast.path("type").asText();
        if ("target_unit".equals(castType) && request.getTargetEntityId() != null) {
            BattleChampionState target = battleRoomManager.findChampion(request.getTargetEntityId()).orElse(null);
            if (target != null && target.getPosition() != null && caster.getPosition() != null) {
                double distance = calculateDistance(caster.getPosition(), target.getPosition());
                if (distance > toleranceRange) {
                    return CastValidationResult.fail("out_of_range",
                            "目标超出施法距离（当前距离: " + String.format("%.1f", distance) + ", 最大距离: " + String.format("%.1f", maxRange) + "）");
                }
            }
        }

        if (("target_point".equals(castType) || "directional".equals(castType)) && request.getTargetPoint() != null) {
            if (caster.getPosition() != null) {
                double distance = calculateDistance(caster.getPosition(), request.getTargetPoint());
                if (distance > toleranceRange) {
                    return CastValidationResult.fail("out_of_range",
                            "目标点超出施法距离（当前距离: " + String.format("%.1f", distance) + ", 最大距离: " + String.format("%.1f", maxRange) + "）");
                }
            }
        }

        return null;
    }

    /**
     * 权威目标规则校验。
     * 当前支持敌我方约束、自身可选约束，以及目标状态存在/不存在约束。
     */
    private CastValidationResult checkTargetRules(BattleChampionState caster, BattleChampionState target, JsonNode targetRules) {
        if (targetRules == null || targetRules.isMissingNode()) {
            return null;
        }

        boolean allowSelf = targetRules.path("allowSelf").asBoolean(false);
        if (caster.getId() != null && caster.getId().equals(target.getId())) {
            if (!allowSelf) {
                return CastValidationResult.fail("invalid_target", "该技能不能以自己为目标");
            }
            return null;
        }

        boolean enemyOnly = targetRules.path("enemyOnly").asBoolean(false);
        if (enemyOnly && isSameTeam(caster, target)) {
            return CastValidationResult.fail("invalid_target", "该技能只能以敌方单位为目标");
        }

        boolean allyOnly = targetRules.path("allyOnly").asBoolean(false);
        if (allyOnly && !isSameTeam(caster, target)) {
            return CastValidationResult.fail("invalid_target", "该技能只能以己方单位为目标");
        }

        String requiresTargetStatusId = targetRules.path("requiresTargetStatusId").asText(null);
        if (requiresTargetStatusId != null && !requiresTargetStatusId.trim().isEmpty()
                && !statusEffectService.hasStatus(target.getId(), requiresTargetStatusId)) {
            return CastValidationResult.fail("invalid_target", "目标未满足技能释放条件");
        }

        String cannotTargetWithStatusId = targetRules.path("cannotTargetWithStatusId").asText(null);
        if (cannotTargetWithStatusId != null && !cannotTargetWithStatusId.trim().isEmpty()
                && statusEffectService.hasStatus(target.getId(), cannotTargetWithStatusId)) {
            return CastValidationResult.fail("invalid_target", "目标当前不满足该技能的锁定条件");
        }

        return null;
    }

    private boolean isSameTeam(BattleChampionState a, BattleChampionState b) {
        if (a == null || b == null) {
            return false;
        }
        if (a.getTeam() == null || b.getTeam() == null) {
            return false;
        }
        return a.getTeam().equals(b.getTeam());
    }

    /**
     * 计算两个三维坐标之间的 XZ 平面距离。
     */
    private double calculateDistance(com.cong.battle3ddemoserver.battle.model.BattleVector3 a,
                                     com.cong.battle3ddemoserver.battle.model.BattleVector3 b) {
        double dx = a.getX() - b.getX();
        double dz = a.getZ() - b.getZ();
        return Math.sqrt(dx * dx + dz * dz);
    }

    /**
     * 获取技能当前等级。
     */
    private int getSkillLevel(BattleChampionState caster, String slot) {
        Map<String, Map<String, Object>> skillStates = caster.getSkillStates();
        if (skillStates == null) {
            return 0;
        }
        Map<String, Object> slotState = skillStates.get(slot);
        if (slotState == null) {
            return 0;
        }
        Object levelObj = slotState.get("level");
        if (levelObj instanceof Number) {
            return ((Number) levelObj).intValue();
        }
        return 0;
    }
}
