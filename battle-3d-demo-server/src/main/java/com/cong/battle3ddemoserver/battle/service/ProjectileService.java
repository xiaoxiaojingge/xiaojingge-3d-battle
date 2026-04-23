package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.AreaEffectState;
import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import com.cong.battle3ddemoserver.battle.model.ProjectileState;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 投射物运行时服务。
 * 负责投射物生成、每 Tick 位移推进、碰撞检测（英雄命中 + 风墙拦截）与过期清理。
 */
@Slf4j
@Service
public class ProjectileService {
    private final List<ProjectileState> activeProjectiles = new CopyOnWriteArrayList<ProjectileState>();
    private final HitResolutionService hitResolutionService;
    private final AreaEffectService areaEffectService;

    public ProjectileService(HitResolutionService hitResolutionService, AreaEffectService areaEffectService) {
        this.hitResolutionService = hitResolutionService;
        this.areaEffectService = areaEffectService;
    }

    /**
     * 生成投射物并加入活跃列表。
     *
     * @param ownerTeam 投射物所有者队伍（用于敌我判定）
     * @param variantId 变体 ID（用于回查效果链，可为 null）
     */
    public ProjectileState spawn(String castInstanceId, String ownerId, String skillId, BattleVector3 position, BattleVector3 direction,
                                 double speed, double radius, boolean blockable, long lifetimeMs,
                                 String ownerTeam, String variantId) {
        long now = System.currentTimeMillis();
        ProjectileState state = ProjectileState.builder()
                .projectileId("projectile-" + UUID.randomUUID().toString())
                .castInstanceId(castInstanceId)
                .ownerId(ownerId)
                .skillId(skillId)
                .position(position)
                .direction(direction)
                .speed(speed)
                .radius(radius)
                .blockable(blockable)
                .hit(Boolean.FALSE)
                .ownerTeam(ownerTeam)
                .variantId(variantId)
                .createdAt(now)
                .expiresAt(now + lifetimeMs)
                .build();
        activeProjectiles.add(state);
        return state;
    }

    /**
     * 兼容旧调用签名（不带 ownerTeam / variantId）。
     */
    public ProjectileState spawn(String castInstanceId, String ownerId, String skillId, BattleVector3 position, BattleVector3 direction,
                                 double speed, double radius, boolean blockable, long lifetimeMs) {
        return spawn(castInstanceId, ownerId, skillId, position, direction, speed, radius, blockable, lifetimeMs, null, null);
    }

    /**
     * 每 Tick 推进投射物位移、执行碰撞检测（英雄命中 + 风墙拦截），并返回本次命中的投射物列表。
     */
    public ProjectileTickResult tick(double deltaSeconds, long now) {
        List<ProjectileHitResult> hitResults = new ArrayList<ProjectileHitResult>();
        List<ProjectileDestroyedResult> destroyedResults = new ArrayList<ProjectileDestroyedResult>();
        for (ProjectileState projectile : activeProjectiles) {
            if (projectile.getHit() != null && projectile.getHit()) {
                continue;
            }
            if (projectile.getPosition() == null || projectile.getDirection() == null || projectile.getSpeed() == null) {
                continue;
            }
            /* ---------- 位移推进 ---------- */
            projectile.getPosition().setX(projectile.getPosition().getX() + projectile.getDirection().getX() * projectile.getSpeed() * deltaSeconds);
            projectile.getPosition().setY(projectile.getPosition().getY() + projectile.getDirection().getY() * projectile.getSpeed() * deltaSeconds);
            projectile.getPosition().setZ(projectile.getPosition().getZ() + projectile.getDirection().getZ() * projectile.getSpeed() * deltaSeconds);

            /* ---------- 风墙拦截检测 ---------- */
            if (projectile.getBlockable() != null && projectile.getBlockable()) {
                if (checkWindWallInterception(projectile)) {
                    projectile.setHit(Boolean.TRUE);
                    destroyedResults.add(new ProjectileDestroyedResult(projectile, "intercepted", null));
                    log.debug("投射物被风墙拦截: projectileId={}", projectile.getProjectileId());
                    continue;
                }
            }

            /* ---------- 英雄碰撞检测 ---------- */
            double hitRadius = projectile.getRadius() != null ? projectile.getRadius() : 0.5;
            List<BattleChampionState> hitTargets = hitResolutionService.findProjectileHits(
                    projectile.getPosition(), hitRadius, projectile.getOwnerId(), projectile.getOwnerTeam());
            if (!hitTargets.isEmpty()) {
                projectile.setHit(Boolean.TRUE);
                hitResults.add(new ProjectileHitResult(projectile, hitTargets));
                destroyedResults.add(new ProjectileDestroyedResult(projectile, "hit", hitTargets));
                log.debug("投射物命中: projectileId={}, hitCount={}", projectile.getProjectileId(), hitTargets.size());
            }
        }

        for (ProjectileState projectile : activeProjectiles) {
            if ((projectile.getHit() == null || !projectile.getHit())
                    && projectile.getExpiresAt() != null
                    && projectile.getExpiresAt() <= now) {
                destroyedResults.add(new ProjectileDestroyedResult(projectile, "expired", null));
            }
        }

        /* ---------- 清理已命中或过期的投射物 ---------- */
        activeProjectiles.removeIf(item ->
                (item.getHit() != null && item.getHit()) ||
                (item.getExpiresAt() != null && item.getExpiresAt() <= now));
        return new ProjectileTickResult(hitResults, destroyedResults);
    }

    public List<ProjectileState> getActiveProjectiles() {
        return activeProjectiles;
    }

    // ==================== 风墙拦截 ====================

    /**
     * 检测投射物是否与任何 wind_wall 类型区域体发生碰撞。
     * 简化模型：将风墙视为一条线段（中心 + 旋转方向 + 长度），
     * 判断投射物圆心到该线段的距离是否小于 (风墙厚度/2 + 投射物半径)。
     */
    private boolean checkWindWallInterception(ProjectileState projectile) {
        for (AreaEffectState area : areaEffectService.getActiveAreas()) {
            if (!"wind_wall".equals(area.getAreaType())) {
                continue;
            }
            /* 风墙所有者的投射物不会被自己的风墙拦截 */
            if (projectile.getOwnerId() != null && projectile.getOwnerId().equals(area.getOwnerId())) {
                continue;
            }
            if (area.getPosition() == null || area.getLength() == null) {
                continue;
            }
            double wallLength = area.getLength();
            double wallThickness = area.getWidth() != null ? area.getWidth() : 0.6;
            double wallRotation = area.getRotationY() != null ? area.getRotationY() : 0D;
            /* 风墙方向向量（沿风墙长度方向，垂直于施法者朝向） */
            double wallDirX = Math.cos(wallRotation);
            double wallDirZ = -Math.sin(wallRotation);
            /* 风墙两端点 */
            double halfLen = wallLength / 2.0;
            double cx = area.getPosition().getX();
            double cz = area.getPosition().getZ();
            /* 投射物到风墙中心的向量 */
            double dx = projectile.getPosition().getX() - cx;
            double dz = projectile.getPosition().getZ() - cz;
            /* 在风墙方向上的投影 */
            double projAlong = dx * wallDirX + dz * wallDirZ;
            if (Math.abs(projAlong) > halfLen + 0.5) {
                continue;
            }
            /* 垂直于风墙方向的距离 */
            double projPerp = Math.abs(dx * (-wallDirZ) + dz * wallDirX);
            double hitThreshold = wallThickness / 2.0 + (projectile.getRadius() != null ? projectile.getRadius() : 0.5);
            if (projPerp <= hitThreshold) {
                return true;
            }
        }
        return false;
    }

    // ==================== 内部结果类 ====================

    /**
     * 投射物命中结果：包含命中的投射物和被命中的目标列表。
     */
    public static class ProjectileHitResult {
        private final ProjectileState projectile;
        private final List<BattleChampionState> hitTargets;

        public ProjectileHitResult(ProjectileState projectile, List<BattleChampionState> hitTargets) {
            this.projectile = projectile;
            this.hitTargets = hitTargets;
        }

        public ProjectileState getProjectile() {
            return projectile;
        }

        public List<BattleChampionState> getHitTargets() {
            return hitTargets;
        }
    }

    /**
     * 投射物销毁结果：记录销毁原因以及可能关联的命中目标。
     */
    public static class ProjectileDestroyedResult {
        private final ProjectileState projectile;
        private final String destroyReason;
        private final List<BattleChampionState> hitTargets;

        public ProjectileDestroyedResult(ProjectileState projectile, String destroyReason, List<BattleChampionState> hitTargets) {
            this.projectile = projectile;
            this.destroyReason = destroyReason;
            this.hitTargets = hitTargets;
        }

        public ProjectileState getProjectile() {
            return projectile;
        }

        public String getDestroyReason() {
            return destroyReason;
        }

        public List<BattleChampionState> getHitTargets() {
            return hitTargets;
        }
    }

    /**
     * 单个 Tick 的投射物推进结果。
     */
    public static class ProjectileTickResult {
        private final List<ProjectileHitResult> hitResults;
        private final List<ProjectileDestroyedResult> destroyedResults;

        public ProjectileTickResult(List<ProjectileHitResult> hitResults, List<ProjectileDestroyedResult> destroyedResults) {
            this.hitResults = hitResults;
            this.destroyedResults = destroyedResults;
        }

        public List<ProjectileHitResult> getHitResults() {
            return hitResults;
        }

        public List<ProjectileDestroyedResult> getDestroyedResults() {
            return destroyedResults;
        }
    }
}
