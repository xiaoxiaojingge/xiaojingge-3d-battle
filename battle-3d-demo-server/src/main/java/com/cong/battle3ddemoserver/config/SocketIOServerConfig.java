package com.cong.battle3ddemoserver.config;

import com.corundumstudio.socketio.AuthorizationResult;
import com.corundumstudio.socketio.Configuration;
import com.corundumstudio.socketio.SocketConfig;
import com.corundumstudio.socketio.SocketIOServer;
import com.corundumstudio.socketio.Transport;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;

import javax.annotation.PreDestroy;

/**
 * netty-socketio 服务器配置。
 * 创建并管理 SocketIOServer 实例，支持 Socket.IO 协议与前端 socket.io-client 对接。
 * 关键优化：启用 TCP_NODELAY 禁用 Nagle 算法，消除延迟堆积。
 */
@Slf4j
@org.springframework.context.annotation.Configuration
@RequiredArgsConstructor
public class SocketIOServerConfig {
    private final BattleServerProperties battleServerProperties;
    private SocketIOServer server;

    /**
     * 创建 SocketIOServer Bean。
     * 配置端口、CORS、心跳、TCP 优化等参数。
     */
    @Bean
    public SocketIOServer socketIOServer() {
        Configuration config = new Configuration();
        /* 监听地址与端口 */
        config.setHostname(battleServerProperties.getWsHost());
        config.setPort(battleServerProperties.getWsPort());

        /* Socket.IO 心跳配置 */
        config.setPingInterval(battleServerProperties.getPingIntervalMs());
        config.setPingTimeout(battleServerProperties.getPingTimeoutMs());

        /* 传输方式：仅使用 WebSocket，跳过 HTTP 长轮询以降低延迟 */
        config.setTransports(Transport.WEBSOCKET);

        /* CORS 配置：允许前端开发服务器跨域连接 */
        String allowedOrigins = battleServerProperties.getAllowedOrigins();
        if (allowedOrigins != null && !allowedOrigins.trim().isEmpty()) {
            config.setOrigin(allowedOrigins);
        }

        /* TCP 底层优化：禁用 Nagle 算法，实现数据实时发送（参考 doubao 优化文档核心建议） */
        SocketConfig socketConfig = new SocketConfig();
        socketConfig.setTcpNoDelay(true);
        socketConfig.setReuseAddress(true);
        socketConfig.setSoLinger(0);
        config.setSocketConfig(socketConfig);

        /* Worker 线程数：CPU 核心数 × 2，充分利用多核（参考 deepseek 优化文档建议） */
        config.setWorkerThreads(Runtime.getRuntime().availableProcessors() * 2);

        /* 授权监听器：当前 Demo 阶段不做鉴权，直接放行 */
        config.setAuthorizationListener(data -> AuthorizationResult.SUCCESSFUL_AUTHORIZATION);

        server = new SocketIOServer(config);
        return server;
    }

    /**
     * 应用关闭时优雅停止 Socket.IO 服务器。
     */
    @PreDestroy
    public void destroy() {
        if (server != null) {
            server.stop();
            log.info("netty-socketio 服务器已关闭");
        }
    }
}
