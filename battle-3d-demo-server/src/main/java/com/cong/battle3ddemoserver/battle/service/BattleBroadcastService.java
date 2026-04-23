package com.cong.battle3ddemoserver.battle.service;

import com.cong.battle3ddemoserver.battle.model.BattleRoom;
import com.cong.battle3ddemoserver.battle.model.PlayerSession;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 战斗广播服务。
 * 基于 netty-socketio 的 sendEvent API 直接发送 Socket.IO 事件。
 * 不再需要手动 JSON 序列化和 TextWebSocketFrame 包装。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BattleBroadcastService {

    /**
     * 向房间内所有在线玩家广播事件。
     */
    public void broadcast(BattleRoom room, String eventType, Object data) {
        room.getPlayers().forEach(player -> sendToPlayer(player, eventType, data));
    }

    /**
     * 向指定玩家发送事件。
     * 使用 SocketIOClient.sendEvent() 直接发送，由 netty-socketio 处理序列化。
     */
    public void sendToPlayer(PlayerSession playerSession, String eventType, Object data) {
        if (playerSession.getClient() == null || !playerSession.getClient().isChannelOpen()) {
            return;
        }
        try {
            playerSession.getClient().sendEvent(eventType, data);
        } catch (Exception exception) {
            log.warn("战斗消息发送失败，eventType={}，sessionId={}", eventType, playerSession.getSessionId(), exception);
        }
    }

    /**
     * 构建标准战斗事件基础载荷。
     * 统一补齐 eventId / sequence / roomId / serverTime 四个关键字段。
     */
    public Map<String, Object> createBaseCombatEvent(BattleRoom room, String eventIdPrefix, long serverTime) {
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        long sequence = room.getSequence().incrementAndGet();
        payload.put("eventId", eventIdPrefix + "-" + sequence);
        payload.put("sequence", sequence);
        payload.put("roomId", room.getRoomId());
        payload.put("serverTime", serverTime);
        return payload;
    }

    /**
     * 广播标准战斗事件。
     * 调用方只需提供事件类型、事件 ID 前缀和额外字段。
     */
    public void broadcastCombatEvent(BattleRoom room, String eventType, String eventIdPrefix, long serverTime,
                                     Map<String, Object> fields) {
        Map<String, Object> payload = createBaseCombatEvent(room, eventIdPrefix, serverTime);
        if (fields != null && !fields.isEmpty()) {
            payload.putAll(fields);
        }
        broadcast(room, eventType, payload);
    }

    /**
     * 单播标准战斗事件。
     */
    public void sendCombatEventToPlayer(PlayerSession playerSession, BattleRoom room, String eventType,
                                        String eventIdPrefix, long serverTime, Map<String, Object> fields) {
        Map<String, Object> payload = createBaseCombatEvent(room, eventIdPrefix, serverTime);
        if (fields != null && !fields.isEmpty()) {
            payload.putAll(fields);
        }
        sendToPlayer(playerSession, eventType, payload);
    }
}
