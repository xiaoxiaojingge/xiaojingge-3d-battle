package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * 命中判定服务。
 * 提供单体、圆形、线性（矩形）、扇形命中查询，以及投射物碰撞检测。
 * 所有判定均在 XZ 平面进行（忽略 Y 轴高度差异）。
 */
@Service
public class HitResolutionService {
    private final BattleRoomManager battleRoomManager;

    /** 英雄默认碰撞半径（用于判定命中时的宽容值）。 */
    private static final double DEFAULT_CHAMPION_RADIUS = 0.5;

    public HitResolutionService(BattleRoomManager battleRoomManager) {
        this.battleRoomManager = battleRoomManager;
    }

    /**
     * 按实体 ID 查找单个目标。
     */
    public BattleChampionState findSingleTarget(String entityId) {
        return battleRoomManager.findChampion(entityId).orElse(null);
    }

    /**
     * 圆形范围命中：返回圆心 center、半径 radius 内的所有英雄。
     */
    public List<BattleChampionState> findTargetsInRadius(BattleVector3 center, double radius) {
        List<BattleChampionState> targets = new ArrayList<BattleChampionState>();
        if (center == null) {
            return targets;
        }
        for (BattleChampionState champion : battleRoomManager.getRoom().getChampions()) {
            if (isDeadOrMissing(champion)) {
                continue;
            }
            double dist = distanceXZ(center, champion.getPosition());
            if (dist <= radius + DEFAULT_CHAMPION_RADIUS) {
                targets.add(champion);
            }
        }
        return targets;
    }

    /**
     * 线性（矩形）范围命中：从 origin 沿 direction 方向、长度 range、宽度 width 的矩形区域内的所有英雄。
     * 使用"点到线段的垂直距离"判定，比纯 AABB 更精确。
     *
     * @param origin    起点坐标
     * @param direction 方向单位向量（XZ 平面）
     * @param range     矩形长度（沿方向的最大距离）
     * @param width     矩形宽度（方向两侧各 width/2）
     * @param excludeId 排除的实体 ID（通常是施法者自己）
     * @return 命中的英雄列表
     */
    public List<BattleChampionState> findTargetsInLine(BattleVector3 origin, BattleVector3 direction,
                                                        double range, double width, String excludeId) {
        List<BattleChampionState> targets = new ArrayList<BattleChampionState>();
        if (origin == null || direction == null) {
            return targets;
        }
        double dirX = direction.getX();
        double dirZ = direction.getZ();
        double dirLen = Math.hypot(dirX, dirZ);
        if (dirLen < 0.001) {
            return targets;
        }
        /* 归一化方向向量 */
        double normX = dirX / dirLen;
        double normZ = dirZ / dirLen;
        /* 法线方向（垂直于 direction，用于计算横向偏移） */
        double perpX = -normZ;
        double perpZ = normX;
        double halfWidth = width / 2.0 + DEFAULT_CHAMPION_RADIUS;

        for (BattleChampionState champion : battleRoomManager.getRoom().getChampions()) {
            if (isDeadOrMissing(champion)) {
                continue;
            }
            if (champion.getId().equals(excludeId)) {
                continue;
            }
            double dx = champion.getPosition().getX() - origin.getX();
            double dz = champion.getPosition().getZ() - origin.getZ();
            /* 在方向轴上的投影距离（纵向） */
            double projForward = dx * normX + dz * normZ;
            if (projForward < -DEFAULT_CHAMPION_RADIUS || projForward > range + DEFAULT_CHAMPION_RADIUS) {
                continue;
            }
            /* 在法线轴上的投影距离（横向） */
            double projPerp = Math.abs(dx * perpX + dz * perpZ);
            if (projPerp <= halfWidth) {
                targets.add(champion);
            }
        }
        return targets;
    }

    /**
     * 扇形范围命中：从 origin 出发、朝 direction 方向、半径 range、半角 halfAngleRad 内的所有英雄。
     *
     * @param origin       扇形顶点
     * @param direction    扇形中心方向（单位向量）
     * @param range        扇形半径
     * @param halfAngleRad 扇形半角（弧度）
     * @param excludeId    排除的实体 ID
     * @return 命中的英雄列表
     */
    public List<BattleChampionState> findTargetsInCone(BattleVector3 origin, BattleVector3 direction,
                                                        double range, double halfAngleRad, String excludeId) {
        List<BattleChampionState> targets = new ArrayList<BattleChampionState>();
        if (origin == null || direction == null) {
            return targets;
        }
        double dirX = direction.getX();
        double dirZ = direction.getZ();
        double dirLen = Math.hypot(dirX, dirZ);
        if (dirLen < 0.001) {
            return targets;
        }
        double normX = dirX / dirLen;
        double normZ = dirZ / dirLen;
        double cosThreshold = Math.cos(halfAngleRad);

        for (BattleChampionState champion : battleRoomManager.getRoom().getChampions()) {
            if (isDeadOrMissing(champion)) {
                continue;
            }
            if (champion.getId().equals(excludeId)) {
                continue;
            }
            double dx = champion.getPosition().getX() - origin.getX();
            double dz = champion.getPosition().getZ() - origin.getZ();
            double dist = Math.hypot(dx, dz);
            if (dist > range + DEFAULT_CHAMPION_RADIUS || dist < 0.001) {
                continue;
            }
            /* 计算目标方向与扇形中心方向的夹角余弦值 */
            double cosAngle = (dx * normX + dz * normZ) / dist;
            if (cosAngle >= cosThreshold) {
                targets.add(champion);
            }
        }
        return targets;
    }

    /**
     * 投射物碰撞检测：检查指定位置、半径的投射物是否命中了任何敌方英雄。
     *
     * @param position  投射物当前位置
     * @param radius    投射物碰撞半径
     * @param ownerId   投射物所有者 ID（排除自己）
     * @param ownerTeam 投射物所有者队伍（只命中敌方）
     * @return 被命中的英雄列表
     */
    public List<BattleChampionState> findProjectileHits(BattleVector3 position, double radius,
                                                         String ownerId, String ownerTeam) {
        List<BattleChampionState> targets = new ArrayList<BattleChampionState>();
        if (position == null) {
            return targets;
        }
        for (BattleChampionState champion : battleRoomManager.getRoom().getChampions()) {
            if (isDeadOrMissing(champion)) {
                continue;
            }
            if (champion.getId().equals(ownerId)) {
                continue;
            }
            /* 只命中敌方 */
            if (ownerTeam != null && ownerTeam.equals(champion.getTeam())) {
                continue;
            }
            double dist = distanceXZ(position, champion.getPosition());
            if (dist <= radius + DEFAULT_CHAMPION_RADIUS) {
                targets.add(champion);
            }
        }
        return targets;
    }

    // ==================== 辅助方法 ====================

    /**
     * 计算两点在 XZ 平面上的距离。
     */
    private double distanceXZ(BattleVector3 a, BattleVector3 b) {
        if (a == null || b == null) {
            return Double.MAX_VALUE;
        }
        double dx = a.getX() - b.getX();
        double dz = a.getZ() - b.getZ();
        return Math.hypot(dx, dz);
    }

    /**
     * 判断英雄是否已死亡或位置缺失。
     */
    private boolean isDeadOrMissing(BattleChampionState champion) {
        return champion == null
                || champion.getPosition() == null
                || (champion.getDead() != null && champion.getDead());
    }
}
