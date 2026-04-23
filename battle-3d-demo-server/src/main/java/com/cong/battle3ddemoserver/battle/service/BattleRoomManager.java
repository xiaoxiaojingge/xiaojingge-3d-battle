package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleRoom;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import com.cong.battle3ddemoserver.battle.model.PlayerSession;
import com.cong.battle3ddemoserver.config.BattleServerProperties;
import com.cong.battle3ddemoserver.shared.SharedProtocolLoader;
import com.corundumstudio.socketio.SocketIOClient;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.annotation.PostConstruct;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 战斗房间管理器。
 * 当前阶段负责单演示房间初始化、玩家接入、英雄分配与基础状态维护。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BattleRoomManager {
    private final BattleServerProperties battleServerProperties;
    private final SharedProtocolLoader sharedProtocolLoader;
    private final HeroSkillDefinitionService heroSkillDefinitionService;

    private BattleRoom room;

    @PostConstruct
    public void init() {
        this.room = BattleRoom.empty(battleServerProperties.getDefaultRoomId());
        loadDemoRoom();
    }

    public BattleRoom getRoom() {
        return room;
    }

    /**
     * 玩家加入默认战斗房间（Socket.IO 版本）。
     * 自动分配可用英雄，若无可用英雄则标记为观战者。
     */
    public PlayerSession joinDefaultRoom(SocketIOClient client, String playerName) {
        String resolvedPlayerName = (playerName == null || playerName.trim().isEmpty())
                ? "玩家-" + (room.getPlayers().size() + 1)
                : playerName.trim();
        String sessionId = client.getSessionId().toString();

        BattleChampionState availableChampion = findFirstAvailableChampion().orElse(null);
        PlayerSession playerSession = PlayerSession.builder()
                .sessionId(sessionId)
                .playerName(resolvedPlayerName)
                .championId(availableChampion != null ? availableChampion.getId() : null)
                .spectator(availableChampion == null)
                .client(client)
                .build();

        room.getPlayers().removeIf(item -> item.getSessionId().equals(sessionId));
        room.getPlayers().add(playerSession);
        return playerSession;
    }

    /**
     * 根据 sessionId 移除玩家会话（用于 Socket.IO 断连回调）。
     */
    public void removeSessionById(String sessionId) {
        if (sessionId == null) {
            return;
        }
        room.getPlayers().removeIf(item -> item.getSessionId().equals(sessionId));
    }

    public Optional<BattleChampionState> findChampion(String championId) {
        return room.getChampions().stream().filter(item -> item.getId().equals(championId)).findFirst();
    }

    private Optional<BattleChampionState> findFirstAvailableChampion() {
        return room.getChampions().stream()
                .filter(champion -> room.getPlayers().stream().noneMatch(player -> champion.getId().equals(player.getChampionId())))
                .findFirst();
    }

    private void loadDemoRoom() {
        JsonNode demoRoomConfig = sharedProtocolLoader.getDemoRoomConfig();
        if (demoRoomConfig == null || demoRoomConfig.isMissingNode()) {
            throw new IllegalStateException("共享层 demo-room 配置不存在，无法初始化战斗房间");
        }

        JsonNode lineup = demoRoomConfig.path("lineup");
        JsonNode spawnLayouts = demoRoomConfig.path("spawnLayouts");
        JsonNode heroMoveSpeeds = demoRoomConfig.path("heroMoveSpeeds");
        int blueIndex = 0;
        int redIndex = 0;

        Iterator<JsonNode> iterator = lineup.elements();
        while (iterator.hasNext()) {
            JsonNode item = iterator.next();
            String team = item.path("team").asText();
            int teamIndex = "blue".equals(team) ? blueIndex++ : redIndex++;
            JsonNode spawn = spawnLayouts.path(team).path(teamIndex);
            double x = spawn.path(0).asDouble();
            double y = spawn.path(1).asDouble();
            double z = spawn.path(2).asDouble();
            String heroId = item.path("heroId").asText();
            JsonNode heroSkillDefinition = heroSkillDefinitionService.getHeroSkillDefinition(heroId);

            room.getChampions().add(BattleChampionState.builder()
                    .id(team + "_" + teamIndex)
                    .heroId(heroId)
                    .skin(item.path("skin").isMissingNode() ? null : item.path("skin").asText(null))
                    .playerName(item.path("playerName").asText())
                    .team(team)
                    .position(BattleVector3.builder().x(x).y(y).z(z).build())
                    .rotation("blue".equals(team) ? 0D : Math.PI)
                    .moveSpeed(heroMoveSpeeds.path(heroId).asDouble(3D))
                    .moveTarget(null)
                    .animationState("idle")
                    .dead(Boolean.FALSE)
                    .hp(1000D)
                    .maxHp(1000D)
                    .mp(600D)
                    .maxMp(600D)
                    .shield(0D)
                    .flowValue(0D)
                    .skillStates(createInitialSkillStates(heroSkillDefinition))
                    .activeCastInstanceId(null)
                    .activeCastPhase("idle")
                    .movementLockedUntil(0L)
                    .idleStartedAt(System.currentTimeMillis())
                    .build());
        }
        log.info("默认战斗房间初始化完成，房间：{}，英雄数量：{}", room.getRoomId(), room.getChampions().size());
    }

    private Map<String, Map<String, Object>> createInitialSkillStates(JsonNode heroSkillDefinition) {
        Map<String, Map<String, Object>> skillStates = new LinkedHashMap<String, Map<String, Object>>();
        appendSkillStates(skillStates, heroSkillDefinition.path("passives"));
        appendSkillStates(skillStates, heroSkillDefinition.path("skills"));
        return skillStates;
    }

    private void appendSkillStates(Map<String, Map<String, Object>> skillStates, JsonNode skills) {
        if (skills == null || !skills.isArray()) {
            return;
        }
        for (JsonNode skill : skills) {
            String slot = skill.path("slot").asText(null);
            if (slot == null || slot.trim().isEmpty()) {
                continue;
            }
            Map<String, Object> state = new LinkedHashMap<String, Object>();
            state.put("slot", slot);
            state.put("skillId", skill.path("skillId").asText(slot));
            state.put("name", skill.path("name").asText(slot));
            state.put("level", skill.path("initialLevel").asInt(1));
            state.put("maxCooldownMs", skill.path("cooldown").path("baseMs").asLong(0L));
            state.put("remainingCooldownMs", 0L);
            state.put("isReady", Boolean.TRUE);
            state.put("insufficientResource", Boolean.FALSE);
            state.put("isSecondPhase", Boolean.FALSE);
            state.put("isCasting", Boolean.FALSE);
            skillStates.put(slot, state);
        }
    }
}
