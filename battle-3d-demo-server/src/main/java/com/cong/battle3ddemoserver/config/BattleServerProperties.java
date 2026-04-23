package com.cong.battle3ddemoserver.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 服务端运行配置。
 * 统一收口 Socket.IO 端口、默认房间、共享层路径与战斗推进节奏。
 */
@Data
@ConfigurationProperties(prefix = "battle-server")
public class BattleServerProperties {
    /**
     * netty-socketio 监听端口（Socket.IO 协议）。
     */
    private Integer wsPort = 8131;

    /**
     * netty-socketio 监听主机地址。
     */
    private String wsHost = "0.0.0.0";

    /**
     * 默认战斗房间 ID。
     */
    private String defaultRoomId = "demo-room";

    /**
     * 战斗 Tick 间隔，单位毫秒。
     */
    private Long tickIntervalMs = 50L;

    /**
     * 快照广播间隔，单位毫秒。
     */
    private Long snapshotIntervalMs = 84L;

    /**
     * 共享层根目录路径。
     */
    private String sharedRootPath = "../battle-3d-demo-shared";

    /**
     * Socket.IO 心跳间隔，单位毫秒。
     */
    private Integer pingIntervalMs = 10000;

    /**
     * Socket.IO 心跳超时，单位毫秒。
     */
    private Integer pingTimeoutMs = 30000;

    /**
     * CORS 允许来源列表，逗号分隔。空字符串表示允许所有。
     */
    private String allowedOrigins = "";
}
