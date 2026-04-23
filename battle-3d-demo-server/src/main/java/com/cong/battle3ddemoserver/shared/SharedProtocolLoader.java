package com.cong.battle3ddemoserver.shared;

import com.cong.battle3ddemoserver.config.BattleServerProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Getter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Stream;

/**
 * 共享层协议与配置加载器。
 * 当前阶段先负责读取协议版本、事件定义、状态定义与亚索技能配置，
 * 为后续服务端校验与客户端对齐提供统一来源。
 */
@Slf4j
@Getter
@Component
@RequiredArgsConstructor
public class SharedProtocolLoader {
    private final BattleServerProperties battleServerProperties;
    private final ObjectMapper objectMapper;

    private JsonNode protocolVersion;
    private JsonNode combatEvents;
    private JsonNode statusEffects;
    private JsonNode demoRoomConfig;
    private Map<String, JsonNode> heroSkillDefinitions = new LinkedHashMap<String, JsonNode>();
    private JsonNode basicHeroTemplateSkills;

    @PostConstruct
    public void load() throws IOException {
        Path rootPath = resolveSharedRootPath();
        protocolVersion = readJson(rootPath, "protocol/version.json");
        combatEvents = readJson(rootPath, "protocol/combat-events.json");
        statusEffects = readJson(rootPath, "status/status-effects.json");
        demoRoomConfig = readJson(rootPath, "config/demo-room.json");
        loadHeroSkillDefinitions(rootPath);
        basicHeroTemplateSkills = readJson(rootPath, "heroes/templates/basic-hero-template.skills.json");
        log.info("共享协议加载完成，协议版本：{}，共享目录：{}，英雄技能定义：{}",
                protocolVersion.path("protocolVersion").asText("unknown"),
                rootPath.toAbsolutePath(),
                heroSkillDefinitions.keySet());
    }

    /**
     * 解析共享层根目录。
     */
    public Path resolveSharedRootPath() {
        return Paths.get(battleServerProperties.getSharedRootPath()).normalize();
    }

    /**
     * 按英雄 ID 获取正式技能定义；不存在时返回 null，由上层决定是否回退模板。
     */
    public JsonNode getHeroSkills(String heroId) {
        if (heroId == null || heroId.trim().isEmpty()) {
            return null;
        }
        return heroSkillDefinitions.get(heroId);
    }

    private void loadHeroSkillDefinitions(Path rootPath) throws IOException {
        Path heroesRoot = rootPath.resolve("heroes").normalize();
        if (!Files.exists(heroesRoot)) {
            throw new IOException("英雄技能目录不存在：" + heroesRoot.toAbsolutePath());
        }
        Map<String, JsonNode> loadedDefinitions = new LinkedHashMap<String, JsonNode>();
        try (Stream<Path> stream = Files.list(heroesRoot)) {
            stream
                    .filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".skills.json"))
                    .forEach(path -> {
                        try {
                            JsonNode heroDefinition = objectMapper.readTree(path.toFile());
                            String heroId = heroDefinition.path("heroId").asText(null);
                            if (heroId == null || heroId.trim().isEmpty()) {
                                log.warn("跳过缺少 heroId 的英雄技能定义：{}", path.toAbsolutePath());
                                return;
                            }
                            loadedDefinitions.put(heroId, heroDefinition);
                        } catch (IOException e) {
                            throw new IllegalStateException("读取英雄技能定义失败：" + path.toAbsolutePath(), e);
                        }
                    });
        } catch (IllegalStateException e) {
            if (e.getCause() instanceof IOException) {
                throw (IOException) e.getCause();
            }
            throw e;
        }
        heroSkillDefinitions = loadedDefinitions;
    }

    private JsonNode readJson(Path rootPath, String relativePath) throws IOException {
        Path targetPath = rootPath.resolve(relativePath).normalize();
        if (!Files.exists(targetPath)) {
            throw new IOException("共享配置不存在：" + targetPath.toAbsolutePath());
        }
        return objectMapper.readTree(targetPath.toFile());
    }
}
