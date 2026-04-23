package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.AreaEffectState;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 区域体运行时服务。
 * 当前阶段先提供区域体登记与过期清理能力。
 */
@Service
public class AreaEffectService {
    private final List<AreaEffectState> activeAreas = new CopyOnWriteArrayList<AreaEffectState>();

    public AreaEffectState create(String castInstanceId, String ownerId, String skillId, String areaType, BattleVector3 position,
                                  double radius, Double rotationY, Double length, Double width, Double height, long lifetimeMs) {
        long now = System.currentTimeMillis();
        AreaEffectState state = AreaEffectState.builder()
                .areaId("area-" + UUID.randomUUID().toString())
                .castInstanceId(castInstanceId)
                .ownerId(ownerId)
                .skillId(skillId)
                .areaType(areaType)
                .position(position)
                .radius(radius)
                .rotationY(rotationY)
                .length(length)
                .width(width)
                .height(height)
                .createdAt(now)
                .expiresAt(now + lifetimeMs)
                .build();
        activeAreas.add(state);
        return state;
    }

    /**
     * 清理并返回本次已过期的区域体，用于广播 AreaExpired 事件。
     */
    public List<AreaEffectState> cleanupExpired(long now) {
        List<AreaEffectState> expiredAreas = new ArrayList<AreaEffectState>();
        for (AreaEffectState area : activeAreas) {
            if (area.getExpiresAt() != null && area.getExpiresAt() <= now) {
                expiredAreas.add(area);
            }
        }
        if (!expiredAreas.isEmpty()) {
            activeAreas.removeAll(expiredAreas);
        }
        return expiredAreas;
    }

    public List<AreaEffectState> getActiveAreas() {
        return activeAreas;
    }
}
