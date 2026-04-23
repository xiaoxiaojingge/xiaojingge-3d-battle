package com.cong.battle3ddemoserver.battle.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

/**
 * 服务端权威英雄运行时状态。
 * 当前阶段先承载移动、朝向、冷却与基础施法骨架，后续逐步扩展到 Buff、投射物与复杂技能状态。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class BattleChampionState {
    private String id;
    private String heroId;
    private String skin;
    private String playerName;
    private String team;
    private BattleVector3 position;
    private Double rotation;
    private Double moveSpeed;
    private BattleVector3 moveTarget;
    private String animationState;
    private Boolean dead;
    private Double hp;
    private Double maxHp;
    private Double mp;
    private Double maxMp;
    private Double shield;
    private Double flowValue;
    private Map<String, Map<String, Object>> skillStates;
    private String activeCastInstanceId;
    private String activeCastPhase;
    private Long movementLockedUntil;
    private Long idleStartedAt;
}
