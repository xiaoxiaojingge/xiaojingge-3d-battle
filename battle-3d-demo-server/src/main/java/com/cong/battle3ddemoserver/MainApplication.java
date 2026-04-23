package com.cong.battle3ddemoserver;

import com.cong.battle3ddemoserver.config.BattleServerProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 3D 对战技能系统正式服务端启动入口。
 */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(BattleServerProperties.class)
public class MainApplication {

    public static void main(String[] args) {
        SpringApplication.run(MainApplication.class, args);
    }
}
