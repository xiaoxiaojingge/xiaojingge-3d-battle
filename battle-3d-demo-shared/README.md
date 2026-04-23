# battle-3d-demo-shared

## 1. 目录定位

该目录用于承载 `battle-3d-demo` 客户端与 `battle-3d-demo-server` 服务端共享的正式技能系统协议与配置。

共享层当前优先承载以下内容：

- 协议版本
- 战斗事件协议
- 技能定义配置
- 状态定义配置
- 共享常量配置

## 2. 设计原则

### 2.1 配置优先

考虑到客户端使用 TypeScript、服务端使用 Java，本目录中的共享内容优先使用 JSON 与 Markdown 描述，避免前后端源码强耦合。

### 2.2 版本先行

所有协议改动必须首先更新 `protocol/version.json`，用于客户端与服务端握手校验、兼容处理与调试定位。

### 2.3 英雄定义与核心协议分离

- `protocol/`：战斗事件与网络协议
- `status/`：状态定义与控制语义
- `heroes/`：英雄技能配置
- `config/`：共享运行参数与默认配置

## 3. 当前目录结构

```text
battle-3d-demo-shared/
├─ README.md
├─ protocol/
│  ├─ version.json
│  └─ combat-events.json
├─ status/
│  └─ status-effects.json
├─ heroes/
│  ├─ yasuo.skills.json
│  └─ templates/
│     └─ basic-hero-template.skills.json
└─ config/
   └─ combat-runtime.json
```

## 4. 当前阶段说明

当前为第一版正式技能系统共享层基线，目标是先建立稳定协议与配置边界，后续再在客户端与服务端分别消费这些定义。
