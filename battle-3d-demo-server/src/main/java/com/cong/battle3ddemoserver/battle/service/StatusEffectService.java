package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.StatusEffectInstance;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Buff / Debuff 运行时服务。
 * 当前阶段先提供基础状态登记、过期清理与快照读取能力。
 */
@Service
public class StatusEffectService {
    private final List<StatusEffectInstance> activeStatusEffects = new CopyOnWriteArrayList<StatusEffectInstance>();

    public StatusEffectInstance apply(String statusId, String sourceEntityId, String targetEntityId, int stacks, long durationMs) {
        long now = System.currentTimeMillis();
        StatusEffectInstance instance = StatusEffectInstance.builder()
                .statusInstanceId("status-" + UUID.randomUUID().toString())
                .statusId(statusId)
                .sourceEntityId(sourceEntityId)
                .targetEntityId(targetEntityId)
                .stacks(stacks)
                .createdAt(now)
                .expiresAt(durationMs > 0 ? now + durationMs : Long.MAX_VALUE)
                .build();
        activeStatusEffects.add(instance);
        return instance;
    }

    /**
     * 清理并返回本次已过期的状态效果，用于广播 StatusRemoved 事件。
     */
    public List<StatusEffectInstance> cleanupExpired(long now) {
        List<StatusEffectInstance> expiredStatuses = new ArrayList<StatusEffectInstance>();
        for (StatusEffectInstance status : activeStatusEffects) {
            if (status.getExpiresAt() != null && status.getExpiresAt() <= now) {
                expiredStatuses.add(status);
            }
        }
        if (!expiredStatuses.isEmpty()) {
            activeStatusEffects.removeAll(expiredStatuses);
        }
        return expiredStatuses;
    }

    public Optional<StatusEffectInstance> findActiveOnTarget(String targetEntityId, String statusId) {
        return activeStatusEffects.stream()
                .filter(item -> targetEntityId != null && targetEntityId.equals(item.getTargetEntityId()))
                .filter(item -> statusId != null && statusId.equals(item.getStatusId()))
                .findFirst();
    }

    public boolean hasStatus(String targetEntityId, String statusId) {
        return findActiveOnTarget(targetEntityId, statusId).isPresent();
    }

    public int getStacks(String targetEntityId, String statusId) {
        return findActiveOnTarget(targetEntityId, statusId)
                .map(StatusEffectInstance::getStacks)
                .orElse(0);
    }

    /**
     * 移除目标身上的指定状态效果，并返回真正被移除的实例列表。
     */
    public List<StatusEffectInstance> remove(String targetEntityId, String statusId, boolean removeAllStacks) {
        List<StatusEffectInstance> removedStatuses = new ArrayList<StatusEffectInstance>();
        for (StatusEffectInstance item : activeStatusEffects) {
            if (targetEntityId == null || statusId == null) {
                continue;
            }
            if (!targetEntityId.equals(item.getTargetEntityId()) || !statusId.equals(item.getStatusId())) {
                continue;
            }
            if (removeAllStacks || item.getStacks() == null || item.getStacks() <= 1) {
                removedStatuses.add(item);
                continue;
            }
            item.setStacks(item.getStacks() - 1);
        }
        if (!removedStatuses.isEmpty()) {
            activeStatusEffects.removeAll(removedStatuses);
        }
        return removedStatuses;
    }

    public List<StatusEffectInstance> getActiveStatusEffects() {
        return activeStatusEffects;
    }
}
