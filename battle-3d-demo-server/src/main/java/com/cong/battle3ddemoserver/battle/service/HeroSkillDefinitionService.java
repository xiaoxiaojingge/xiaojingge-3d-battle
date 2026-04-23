package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.shared.SharedProtocolLoader;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * 英雄技能定义解析服务。
 * 当前阶段先提供按英雄读取共享层 JSON 的能力，后续再补充缓存索引、版本控制与多英雄定义加载。
 */
@Service
@RequiredArgsConstructor
public class HeroSkillDefinitionService {
    private final SharedProtocolLoader sharedProtocolLoader;

    public JsonNode getHeroSkillDefinition(String heroId) {
        JsonNode heroDefinition = sharedProtocolLoader.getHeroSkills(heroId);
        if (heroDefinition != null && !heroDefinition.isMissingNode()) {
            return heroDefinition;
        }
        return sharedProtocolLoader.getBasicHeroTemplateSkills();
    }

    /**
     * 获取英雄完整技能定义（包括 passives、skills 等所有顶层节点）。
     */
    public JsonNode getAllSkillsByHeroId(String heroId) {
        return getHeroSkillDefinition(heroId);
    }

    public JsonNode findSkillById(String heroId, String skillId) {
        JsonNode heroDefinition = getHeroSkillDefinition(heroId);
        JsonNode skills = heroDefinition.path("skills");
        for (JsonNode skill : skills) {
            if (skillId.equals(skill.path("skillId").asText())) {
                return skill;
            }
        }
        return null;
    }

    public JsonNode findSkillBySlot(String heroId, String slot) {
        JsonNode heroDefinition = getHeroSkillDefinition(heroId);
        JsonNode skills = heroDefinition.path("skills");
        for (JsonNode skill : skills) {
            if (slot.equals(skill.path("slot").asText())) {
                return skill;
            }
        }
        return null;
    }
}
