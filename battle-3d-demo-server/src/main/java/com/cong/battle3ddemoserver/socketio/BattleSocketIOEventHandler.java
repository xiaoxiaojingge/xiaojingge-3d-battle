package com.cong.battle3ddemoserver.socketio;

import com.cong.battle3ddemoserver.battle.model.ActiveSpellInstance;
import com.cong.battle3ddemoserver.battle.model.BattleChampionState;
import com.cong.battle3ddemoserver.battle.model.BattleRoom;
import com.cong.battle3ddemoserver.battle.model.BattleVector3;
import com.cong.battle3ddemoserver.battle.model.CastValidationResult;
import com.cong.battle3ddemoserver.battle.model.PlayerSession;
import com.cong.battle3ddemoserver.battle.model.SpellCastRequest;
import com.cong.battle3ddemoserver.battle.service.BattleBroadcastService;
import com.cong.battle3ddemoserver.battle.service.BattlePayloadMapper;
import com.cong.battle3ddemoserver.battle.service.BattleRoomManager;
import com.cong.battle3ddemoserver.battle.service.SpellLifecycleService;
import com.corundumstudio.socketio.SocketIOClient;
import com.corundumstudio.socketio.SocketIOServer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 战斗 Socket.IO 事件处理器。
 * 负责注册所有客户端事件监听器并在所有监听器就绪后启动服务器。
 * 替代原 NettyWebSocketServerHandler，使用 netty-socketio 的事件驱动模型。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class BattleSocketIOEventHandler {
    private final SocketIOServer socketIOServer;
    private final ObjectMapper objectMapper;
    private final BattleRoomManager battleRoomManager;
    private final BattleBroadcastService battleBroadcastService;
    private final BattlePayloadMapper battlePayloadMapper;
    private final SpellLifecycleService spellLifecycleService;

    /**
     * 注册所有事件监听器并启动 Socket.IO 服务器。
     * 必须在 @PostConstruct 中完成，确保监听器先于服务器启动注册。
     */
    @PostConstruct
    public void init() {
        /* ========== 连接/断连生命周期 ========== */
        socketIOServer.addConnectListener(this::onConnect);
        socketIOServer.addDisconnectListener(this::onDisconnect);

        /* ========== 入房事件 ========== */
        socketIOServer.addEventListener("room:join", JsonNode.class, (client, data, ackRequest) -> {
            handleJoin(client, data);
        });

        /* ========== 英雄移动 ========== */
        socketIOServer.addEventListener("champion:move", JsonNode.class, (client, data, ackRequest) -> {
            handleMove(client, data);
        });
        /* 兼容旧事件名 "move" */
        socketIOServer.addEventListener("move", JsonNode.class, (client, data, ackRequest) -> {
            handleMove(client, data);
        });

        /* ========== 英雄停止 ========== */
        socketIOServer.addEventListener("champion:stop", JsonNode.class, (client, data, ackRequest) -> {
            handleStop(client, data);
        });
        /* 兼容旧事件名 "stop" */
        socketIOServer.addEventListener("stop", JsonNode.class, (client, data, ackRequest) -> {
            handleStop(client, data);
        });

        /* ========== 施法意图 ========== */
        socketIOServer.addEventListener("castSpell", JsonNode.class, (client, data, ackRequest) -> {
            handleCastIntent(client, "castSpell", data);
        });
        socketIOServer.addEventListener("basicAttack", JsonNode.class, (client, data, ackRequest) -> {
            handleCastIntent(client, "basicAttack", data);
        });

        /* ========== 表现层转发（动画/表情/语音） ========== */
        socketIOServer.addEventListener("champion:animate", JsonNode.class, (client, data, ackRequest) -> {
            handleBroadcastRelay(client, "champion:animate", data);
        });
        socketIOServer.addEventListener("champion:emote", JsonNode.class, (client, data, ackRequest) -> {
            handleBroadcastRelay(client, "champion:emote", data);
        });
        socketIOServer.addEventListener("champion:voice", JsonNode.class, (client, data, ackRequest) -> {
            handleBroadcastRelay(client, "champion:voice", data);
        });

        /* 所有监听器注册完毕，启动服务器 */
        socketIOServer.start();
        log.info("netty-socketio 服务器启动成功，所有事件监听器已注册");
    }

    /* ==================== 连接生命周期 ==================== */

    /**
     * 客户端连接事件。
     * Socket.IO 的 sessionId 自动由 netty-socketio 管理，无需手动分配。
     */
    private void onConnect(SocketIOClient client) {
        log.info("Socket.IO 客户端已连接，sessionId={}", client.getSessionId());
    }

    /**
     * 客户端断连事件。
     * 清理玩家会话，释放英雄占位。
     */
    private void onDisconnect(SocketIOClient client) {
        String sessionId = client.getSessionId().toString();
        battleRoomManager.removeSessionById(sessionId);
        log.info("Socket.IO 客户端已断开，sessionId={}", sessionId);
    }

    /* ==================== 入房处理 ==================== */

    /**
     * 处理 room:join 事件。
     * 分配英雄并回传入房结果。
     */
    private void handleJoin(SocketIOClient client, JsonNode payload) {
        String playerName = payload != null ? payload.path("playerName").asText(null) : null;
        PlayerSession playerSession = battleRoomManager.joinDefaultRoom(client, playerName);
        BattleChampionState assignedChampion = playerSession.getChampionId() != null
                ? battleRoomManager.findChampion(playerSession.getChampionId()).orElse(null)
                : null;

        Map<String, Object> joinedPayload = new LinkedHashMap<String, Object>();
        joinedPayload.put("roomId", battleRoomManager.getRoom().getRoomId());
        joinedPayload.put("sessionId", playerSession.getSessionId());
        joinedPayload.put("playerName", playerSession.getPlayerName());
        joinedPayload.put("championId", playerSession.getChampionId());
        joinedPayload.put("team", assignedChampion != null ? assignedChampion.getTeam() : null);
        joinedPayload.put("spectator", playerSession.getSpectator());
        /* 入房结果仅通知当前客户端 */
        battleBroadcastService.sendToPlayer(playerSession, "room:joined", joinedPayload);
    }

    /* ==================== 移动/停止处理 ==================== */

    /**
     * 处理 champion:move 事件。
     * 设置英雄移动目标点，由服务端权威 tick 推进实际位移。
     */
    private void handleMove(SocketIOClient client, JsonNode payload) {
        if (payload == null || payload.path("championId").isMissingNode()) {
            return;
        }
        String championId = payload.path("championId").asText();
        /* 兼容前端 targetPoint / target 两种字段名，优先读 targetPoint */
        JsonNode pointNode = payload.has("targetPoint") && !payload.path("targetPoint").isNull()
                ? payload.path("targetPoint")
                : payload.has("target") && !payload.path("target").isNull()
                        ? payload.path("target")
                        : null;
        /* 坐标字段不存在或缺少 x/z 时直接忽略，避免误设为 (0,0,0) */
        if (pointNode == null || pointNode.isMissingNode() || pointNode.isNull()
                || !pointNode.has("x") || !pointNode.has("z")) {
            log.warn("[handleMove] 移动指令缺少有效坐标字段，已忽略: championId={}", championId);
            return;
        }
        /* 校验当前连接是否有权控制该英雄 */
        PlayerSession session = findSessionByClient(client);
        if (session == null || !championId.equals(session.getChampionId())) {
            log.warn("[handleMove] 连接无权控制该英雄: sessionChampion={}, requestedChampion={}",
                    session != null ? session.getChampionId() : "null", championId);
            return;
        }
        battleRoomManager.findChampion(championId).ifPresent(champion ->
            champion.setMoveTarget(BattleVector3.builder()
                    .x(pointNode.path("x").asDouble())
                    .y(0D)
                    .z(pointNode.path("z").asDouble())
                    .build())
        );
    }

    /**
     * 处理 champion:stop 事件。
     * 清除英雄移动目标，由服务端 tick 切换为 idle 状态。
     */
    private void handleStop(SocketIOClient client, JsonNode payload) {
        if (payload == null || payload.path("championId").isMissingNode()) {
            return;
        }
        String championId = payload.path("championId").asText();
        /* 校验当前连接是否有权控制该英雄 */
        PlayerSession session = findSessionByClient(client);
        if (session == null || !championId.equals(session.getChampionId())) {
            return;
        }
        battleRoomManager.findChampion(championId).ifPresent(champion -> {
            champion.setMoveTarget(null);
            /* 立即将动画状态切换为 idle，避免 moveTarget 已清但 animationState 残留 run
             * 导致前端在 tick 间隙收到不一致快照而产生动画抽搐 */
            champion.setAnimationState("idle");
            champion.setIdleStartedAt(System.currentTimeMillis());
        });
    }

    /* ==================== 施法处理 ==================== */

    /**
     * 处理 castSpell / basicAttack 事件。
     * 验证施法条件 → 通过则创建技能实例 → 广播 accepted/started。
     * 验证失败则仅回传 rejected 给施法者。
     */
    private void handleCastIntent(SocketIOClient client, String requestType, JsonNode payload) {
        if (payload == null) {
            return;
        }
        BattleRoom room = battleRoomManager.getRoom();
        SpellCastRequest spellCastRequest = battlePayloadMapper.toSpellCastRequest(payload);
        if ("basicAttack".equals(requestType) && spellCastRequest.getSlot() == null) {
            spellCastRequest.setSlot("basicAttack");
        }

        CastValidationResult validationResult = spellLifecycleService.validate(spellCastRequest);
        if (!validationResult.isPassed()) {
            Map<String, Object> rejectedPayload = new LinkedHashMap<String, Object>();
            rejectedPayload.put("eventId", requestType + "-rejected-" + room.getSequence().incrementAndGet());
            rejectedPayload.put("sequence", room.getSequence().get());
            rejectedPayload.put("roomId", room.getRoomId());
            rejectedPayload.put("serverTime", System.currentTimeMillis());
            rejectedPayload.put("requestId", spellCastRequest.getRequestId());
            rejectedPayload.put("casterId", spellCastRequest.getCasterId());
            rejectedPayload.put("skillId", spellCastRequest.getSkillId());
            rejectedPayload.put("slot", spellCastRequest.getSlot());
            rejectedPayload.put("reasonCode", validationResult.getReasonCode());
            rejectedPayload.put("reasonMessage", validationResult.getReasonMessage());
            /* 施法被拒绝仅通知施法者本人 */
            PlayerSession requester = findSessionByClient(client);
            if (requester != null) {
                battleBroadcastService.sendToPlayer(requester, "spellCastRejected", rejectedPayload);
            }
            return;
        }

        ActiveSpellInstance activeSpellInstance = spellLifecycleService.create(spellCastRequest);
        Map<String, Object> acceptedPayload = new LinkedHashMap<String, Object>();
        acceptedPayload.put("eventId", requestType + "-accepted-" + room.getSequence().incrementAndGet());
        acceptedPayload.put("sequence", room.getSequence().get());
        acceptedPayload.put("roomId", room.getRoomId());
        acceptedPayload.put("serverTime", System.currentTimeMillis());
        acceptedPayload.put("requestType", requestType);
        acceptedPayload.put("requestId", spellCastRequest.getRequestId());
        acceptedPayload.put("castInstanceId", activeSpellInstance.getCastInstanceId());
        acceptedPayload.put("casterId", activeSpellInstance.getCasterId());
        acceptedPayload.put("skillId", activeSpellInstance.getSkillId());
        acceptedPayload.put("slot", activeSpellInstance.getSlot());
        battleBroadcastService.broadcast(room, "spellCastAccepted", acceptedPayload);

        Map<String, Object> startedPayload = new LinkedHashMap<String, Object>();
        startedPayload.put("eventId", "spell-started-" + room.getSequence().incrementAndGet());
        startedPayload.put("sequence", room.getSequence().get());
        startedPayload.put("roomId", room.getRoomId());
        startedPayload.put("serverTime", System.currentTimeMillis());
        startedPayload.put("castInstanceId", activeSpellInstance.getCastInstanceId());
        startedPayload.put("casterId", activeSpellInstance.getCasterId());
        startedPayload.put("skillId", activeSpellInstance.getSkillId());
        startedPayload.put("slot", activeSpellInstance.getSlot());
        startedPayload.put("stage", activeSpellInstance.getStage());
        startedPayload.put("targetEntityId", activeSpellInstance.getTargetEntityId());
        startedPayload.put("targetPoint", activeSpellInstance.getTargetPoint());
        battleBroadcastService.broadcast(room, "spellCastStarted", startedPayload);
    }

    /* ==================== 表现层转发 ==================== */

    /**
     * 通用转发型处理：将客户端发来的动画/表情/语音请求原样广播给房间内所有玩家。
     * 不做服务端校验（这些都是纯表现层消息），仅补充服务端时间戳。
     */
    private void handleBroadcastRelay(SocketIOClient client, String eventType, JsonNode payload) {
        if (payload == null) {
            return;
        }
        BattleRoom room = battleRoomManager.getRoom();
        if (room == null) {
            return;
        }
        Map<String, Object> relayPayload = new LinkedHashMap<String, Object>();
        relayPayload.put("serverTime", System.currentTimeMillis());
        /* 将原始 payload 中的所有字段透传 */
        payload.fields().forEachRemaining(entry -> relayPayload.put(entry.getKey(), entry.getValue()));
        battleBroadcastService.broadcast(room, eventType, relayPayload);
    }

    /* ==================== 辅助方法 ==================== */

    /**
     * 根据 SocketIOClient 查找对应的玩家会话。
     */
    private PlayerSession findSessionByClient(SocketIOClient client) {
        String sessionId = client.getSessionId().toString();
        BattleRoom room = battleRoomManager.getRoom();
        if (room == null || room.getPlayers() == null) {
            return null;
        }
        return room.getPlayers().stream()
                .filter(p -> sessionId.equals(p.getSessionId()))
                .findFirst()
                .orElse(null);
    }
}
