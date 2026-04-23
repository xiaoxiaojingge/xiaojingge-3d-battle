# Unity WebGL 备选技术方案

> **文档性质**：备选方案（当前主方案为 Three.js）  
> **适用场景**：若 Three.js 方案在画面品质、3D 模型工作流或团战性能上无法满足 LoL 级视觉要求，可切换至本方案  
> **关联主文档**：[方案设计文档.md](./方案设计文档.md)

---

## 1. 方案概述

使用 **Unity 2022 LTS + WebGL 构建目标**，将完整 Unity 游戏导出为 WebGL，嵌入现有 React + UmiJS Max 项目。Unity 作为专业游戏引擎，在 3D 渲染品质、动画系统、物理引擎、粒子系统、Shader 编辑等方面远超纯 Web 3D 库，可直接对标 LoL/王者荣耀级视觉效果。

### 核心优势

| 维度 | Unity WebGL | Three.js（主方案） |
|:-----|:-----------|:------------------|
| 渲染品质 | **AAA 级**（URP/HDRP 管线、烘焙光照、实时 GI） | 良好（PBR + 手动后处理） |
| 3D 模型工作流 | **编辑器内拖拽导入**，FBX/glTF/OBJ 原生支持 | 代码加载，调试不便 |
| 骨骼动画 | **Mecanim 状态机**，可视化编辑，动画混合树 | AnimationMixer + 手写状态机 |
| 粒子系统 | **Visual Effect Graph / Shuriken**，编辑器内实时预览 | 手写或 three-nebula 插件 |
| Shader | **Shader Graph** 可视化编辑 | 手写 GLSL/ShaderMaterial |
| 物理引擎 | **PhysX** 内置（碰撞/触发/刚体/关节） | 需集成 cannon-es/rapier |
| UI 系统 | **Unity UI Toolkit / UGUI** | 需 React HUD 覆盖层 |
| 热更新 | Addressables 远程资源 | 天然（Web 资源） |
| 开发效率 | **极高**（可视化编辑器+组件系统） | 中（纯代码） |

### 核心劣势

| 维度 | Unity WebGL 劣势 | 影响 |
|:-----|:-----------------|:-----|
| **初始包体积** | gzip 后 5-15MB（WASM + 运行时 + 资源） | 首屏加载慢，需 Loading 过渡 |
| **内存占用** | 浏览器 WASM 堆 256-512MB | 低端设备可能 OOM |
| **React 集成** | iframe/WebGL Canvas 嵌入，通信靠 JS 桥接 | 集成复杂度高 |
| **构建迭代** | Unity Build 耗时 2-5 分钟/次 | 开发节奏慢于 Web HMR |
| **移动浏览器** | iOS Safari WebGL WASM 支持有限 | 移动端兼容性差 |
| **多线程** | WebGL 无原生多线程（SharedArrayBuffer 受限） | 计算密集任务需优化 |
| **SEO/可达性** | WebGL Canvas 内容不可索引 | 对本项目无影响 |

---

## 2. 技术架构

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                       浏览器（PC Chrome）                         │
│  ┌──────────────┐  ┌──────────────────────────────┐             │
│  │ 大厅 (React) │  │      Unity WebGL Canvas       │             │
│  │ Ant Design   │  │  ┌─────────────────────────┐  │             │
│  │ 房间/队伍    │  │  │ URP 渲染管线            │  │             │
│  │              │  │  │ 3D场景/模型/光影/粒子   │  │             │
│  │              │  │  │ Mecanim 动画            │  │             │
│  │              │  │  │ PhysX 碰撞              │  │             │
│  │              │  │  │ UGUI HUD (可选)         │  │             │
│  │              │  │  └─────────────────────────┘  │             │
│  └──────┬───────┘  └──────────────┬─────────────────┘             │
│  ┌──────┴─────────────────────────┴────────────────────────────┐ │
│  │  JS ↔ Unity 桥接层 (jslib + SendMessage / ExternCall)      │ │
│  │  WebSocket Client (ws://host:8090)                          │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
└─────────────────────────────┼────────────────────────────────────┘
                              │ WebSocket
┌─────────────────────────────┼────────────────────────────────────┐
│                     Netty Server (8090)                           │
│              （与主方案完全一致，无需改动）                         │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Unity 与 React 集成方式

#### 方式一：iframe 嵌入（推荐）

```
React App (UmiJS Max)
├── 游戏大厅页（纯 React）
├── 游戏对战页
│   ├── <iframe src="/unity/index.html" />  ← Unity WebGL 产物
│   └── window.postMessage() ↔ iframe       ← 双向通信
└── 结算页（纯 React）
```

**优点**：隔离性好，Unity 崩溃不影响主应用；内存独立回收  
**缺点**：通信需序列化，延迟 ~1ms

#### 方式二：同页嵌入

```
React App (UmiJS Max)
├── 游戏对战页
│   ├── <div id="unity-canvas" />             ← Unity 挂载点
│   ├── createUnityInstance(canvas, config)    ← Unity Loader API
│   ├── unityInstance.SendMessage(...)         ← React → Unity
│   └── window.UnityCallback = (data) => {}   ← Unity → React (jslib)
└── HUD 层（React absolute 覆盖在 Unity Canvas 上方）
```

**优点**：通信更直接，可用 React HUD 覆盖层  
**缺点**：Unity 与 React 共享内存空间，需注意内存管理

### 2.3 JS ↔ Unity 通信协议

#### React → Unity（调用 Unity C# 方法）

```javascript
// 通过 Unity Loader API
unityInstance.SendMessage('GameManager', 'OnGameState', jsonString);
unityInstance.SendMessage('GameManager', 'OnPlayerAction', jsonString);
```

#### Unity → React（C# 调用外部 JS）

```csharp
// C# 侧
[DllImport("__Internal")]
private static extern void SendToReact(string eventName, string jsonData);

// 调用
SendToReact("onKillEvent", JsonUtility.ToJson(killData));
```

```javascript
// jslib 桥接文件 (Plugins/WebGL/bridge.jslib)
mergeInto(LibraryManager.library, {
  SendToReact: function(eventNamePtr, jsonDataPtr) {
    var eventName = UTF8ToString(eventNamePtr);
    var jsonData = UTF8ToString(jsonDataPtr);
    window.dispatchEvent(new CustomEvent(eventName, { detail: JSON.parse(jsonData) }));
  }
});
```

#### WebSocket 消息路由

```
浏览器 WS Client (React层)
    │
    ├── 大厅消息 → React 直接处理
    │
    └── 游戏消息 (GAME_STATE/SKILL_EFFECT/...)
         │
         ├── HUD 相关 → React HUD 组件更新
         └── 3D 渲染相关 → SendMessage → Unity 场景更新
```

---

## 3. Unity 项目结构

```
UnityProject/
├── Assets/
│   ├── Scenes/
│   │   ├── BattleScene.unity           # 主战斗场景
│   │   └── LoadingScene.unity          # 加载场景
│   ├── Scripts/
│   │   ├── Core/
│   │   │   ├── GameManager.cs          # 游戏管理器（接收 WS 状态）
│   │   │   ├── NetworkBridge.cs        # JS ↔ Unity 通信桥接
│   │   │   └── StateInterpolation.cs   # 状态插值（60FPS 平滑）
│   │   ├── Entity/
│   │   │   ├── Champion.cs             # 英雄实体
│   │   │   ├── Tower.cs                # 防御塔
│   │   │   ├── Nexus.cs                # 水晶枢纽
│   │   │   └── Projectile.cs           # 弹道投射物
│   │   ├── Animation/
│   │   │   └── ChampionAnimController.cs # 动画状态机控制
│   │   ├── Camera/
│   │   │   └── MOBACameraController.cs # LoL 风格摄像机
│   │   ├── Input/
│   │   │   └── MOBAInputHandler.cs     # 键鼠输入处理
│   │   ├── Effects/
│   │   │   ├── SkillVFXManager.cs      # 技能特效管理
│   │   │   └── SnowParticleSystem.cs   # 雪花粒子
│   │   └── UI/ (可选，也可用 React 覆盖层)
│   │       ├── BattleHUD.cs            # 战斗 HUD
│   │       └── MiniMap.cs              # 小地图
│   ├── Models/
│   │   ├── Champions/                  # 英雄 FBX/glTF 模型
│   │   │   ├── Lux/
│   │   │   ├── Braum/
│   │   │   └── ...
│   │   ├── Structures/                 # 建筑模型
│   │   │   ├── Tower.fbx
│   │   │   └── Nexus.fbx
│   │   └── Environment/               # 环境模型
│   │       ├── Bridge.fbx
│   │       └── Props/
│   ├── Animations/
│   │   ├── Champions/                  # 英雄动画 FBX
│   │   │   ├── Idle.fbx
│   │   │   ├── Run.fbx
│   │   │   ├── Attack.fbx
│   │   │   ├── Cast.fbx
│   │   │   └── Death.fbx
│   │   └── AnimatorControllers/        # Mecanim 控制器
│   │       └── ChampionAnimator.controller
│   ├── Materials/                      # PBR 材质
│   ├── Textures/                       # 贴图
│   ├── Shaders/                        # 自定义 Shader
│   │   └── IceShader.shadergraph       # 冰面 Shader Graph
│   ├── VFX/                            # Visual Effect Graph 特效
│   │   ├── SkillEffects/
│   │   └── EnvironmentEffects/
│   ├── Prefabs/
│   │   ├── Champions/                  # 英雄预制体
│   │   ├── Structures/                 # 建筑预制体
│   │   └── Effects/                    # 特效预制体
│   ├── Plugins/
│   │   └── WebGL/
│   │       └── bridge.jslib            # JS 桥接
│   ├── Resources/                      # 运行时加载资源
│   └── Settings/
│       └── URPSettings.asset           # URP 渲染管线设置
├── Packages/                           # Unity 包管理
├── ProjectSettings/
│   ├── ProjectSettings.asset
│   └── QualitySettings.asset           # WebGL 画质降级配置
└── WebGLTemplates/                     # 自定义 WebGL 模板
    └── MoYuBattle/
        └── index.html                  # 自定义加载页
```

---

## 4. 渲染管线配置

### 4.1 URP（Universal Render Pipeline）

选择 URP 而非 HDRP，因为 WebGL 不支持 HDRP 的高级特性（光线追踪、SSGI），且 URP 性能更适合浏览器。

| 配置项 | WebGL 推荐值 | 说明 |
|:-------|:------------|:-----|
| 渲染管线 | URP | WebGL 唯一可用管线 |
| 阴影分辨率 | 1024×1024 | 降低 GPU 负担 |
| 阴影级联 | 2 | 减少 Draw Call |
| MSAA | 2x 或关闭 | WebGL 抗锯齿开销大 |
| 后处理 | Bloom + Color Grading | 必要的画面提升 |
| HDR | 关闭 | WebGL 不完整支持 |
| 深度纹理 | 开启 | Fog/粒子需要 |
| SRP Batcher | 开启 | 减少 Draw Call |

### 4.2 光照方案

```
方案：烘焙光照 + 少量实时光

环境光：Skybox(冰蓝渐变) + Ambient(0.4 Intensity)
主方向光：烘焙 Lightmap + 实时阴影(1盏)
塔顶/水晶：实时 PointLight × 6（低范围）
团队色光：蓝/红 PointLight × 2（烘焙）

Lightmap 分辨率：20 texels/unit
Lightmap 压缩：Low Quality（减小 WebGL 包体积）
```

**烘焙优势**：将复杂光照计算从运行时转移到构建时，WebGL 运行时只需采样 Lightmap，大幅提升帧率。

### 4.3 Shader 规范

| Shader | 用途 | 复杂度 |
|:-------|:-----|:-------|
| URP/Lit | 英雄模型、建筑 | 中 |
| URP/SimpleLit | 地形、装饰物 | 低 |
| Custom/IceSurface | 冰面（次表面散射模拟 + 反射） | 中 |
| Custom/CrystalGlow | 水晶发光（菲涅尔 + 自发光脉冲） | 低 |
| URP/Particles | 粒子（Additive/Alpha） | 低 |

> WebGL Shader 限制：不支持 Compute Shader、Tessellation，Shader 复杂度直接影响编译时间。

---

## 5. 英雄系统

### 5.1 Mecanim 动画状态机

```
┌─────────────────────────────────────────────┐
│           Animator Controller                │
│                                             │
│   Entry → [Idle] ←──────────────────┐       │
│             │                       │       │
│          Speed>0.1               AnimEnd    │
│             ▼                       │       │
│           [Run] ──── Attack ──→ [Attack]    │
│             │                       │       │
│          Skill     ┌── AnimEnd ─────┘       │
│             ▼      │                        │
│          [Cast] ───┘                        │
│             │                               │
│          HP<=0                              │
│             ▼                               │
│          [Death] ── Revive ──→ [Idle]       │
└─────────────────────────────────────────────┘

过渡配置：
- Idle → Run：Has Exit Time = false, 过渡 0.1s
- Run → Idle：Has Exit Time = false, 过渡 0.15s
- Any → Attack：Trigger "Attack", 过渡 0.05s
- Any → Cast：Trigger "Cast", 过渡 0.08s
- Any → Death：Trigger "Death", 过渡 0s
- Death → Idle：Trigger "Revive", 过渡 0.3s
```

### 5.2 模型规格

| 项目 | 规格 | 说明 |
|:-----|:-----|:-----|
| 多边形面数 | 3000-8000 三角面/英雄 | Unity 优化批处理，可比 Three.js 更高 |
| 骨骼数 | 30-50 | Humanoid Avatar 标准绑定 |
| 纹理 | 512×512（Albedo + Normal + Mask） | Crunch 压缩减小包体 |
| LOD | 2 级（近/远） | LOD Group 自动切换 |
| 动画 | 5 个 AnimationClip/英雄 | 可 Retarget 共享动画 |
| Skinned Mesh | 最多 2 个 Renderer/英雄 | 身体 + 武器分离 |

**Humanoid Retargeting 优势**：所有英雄使用 Humanoid Avatar，idle/run/death 等通用动画可**共享**，只需定制 attack/cast 动画，大幅减少资源量。

### 5.3 模型来源

| 阶段 | 来源 | 说明 |
|:-----|:-----|:-----|
| Phase 1 | Unity Asset Store 免费/低价角色 | 快速原型（如 "Low Poly Characters"） |
| Phase 2 | Mixamo 自动绑定 + Retarget | 将外部模型导入 Mixamo 获取动画 |
| Phase 3 | 定制低多边形 LoL 风格模型 | Blender 制作 → FBX 导出 → Unity 导入 |

---

## 6. 摄像机系统

### MOBACameraController.cs 核心逻辑

```csharp
public class MOBACameraController : MonoBehaviour
{
    [Header("Camera Settings")]
    public float height = 30f;           // Y 高度
    public float angle = 50f;            // X 旋转角度（俯角）
    public float followSpeed = 8f;       // 跟随平滑度
    
    [Header("Zoom")]
    public float minHeight = 15f;
    public float maxHeight = 50f;
    public float zoomSpeed = 5f;
    
    [Header("Edge Pan")]
    public float edgePanSpeed = 25f;
    public float edgeThreshold = 20f;    // 像素
    public bool enableEdgePan = true;
    
    [Header("Lock")]
    public Transform followTarget;       // 锁定目标（自己的英雄）
    public bool isLocked = true;         // Y 键切换锁定/自由
    
    private Vector3 targetPosition;
    
    void Update()
    {
        // 滚轮缩放
        float scroll = Input.GetAxis("Mouse ScrollWheel");
        height = Mathf.Clamp(height - scroll * zoomSpeed, minHeight, maxHeight);
        
        // Y 键切换锁定
        if (Input.GetKeyDown(KeyCode.Y))
            isLocked = !isLocked;
        
        // 空格键临时回到自己
        if (Input.GetKey(KeyCode.Space) && followTarget != null)
            targetPosition = followTarget.position;
        
        // 边缘平移（非锁定模式）
        if (!isLocked && enableEdgePan)
        {
            Vector3 pan = Vector3.zero;
            Vector2 mouse = Input.mousePosition;
            if (mouse.x < edgeThreshold) pan.x -= edgePanSpeed * Time.deltaTime;
            if (mouse.x > Screen.width - edgeThreshold) pan.x += edgePanSpeed * Time.deltaTime;
            if (mouse.y < edgeThreshold) pan.z -= edgePanSpeed * Time.deltaTime;
            if (mouse.y > Screen.height - edgeThreshold) pan.z += edgePanSpeed * Time.deltaTime;
            targetPosition += pan;
        }
        else if (isLocked && followTarget != null)
        {
            targetPosition = followTarget.position;
        }
        
        // 平滑跟随
        Vector3 desiredPos = targetPosition + Quaternion.Euler(angle, 0, 0) * Vector3.back * height;
        transform.position = Vector3.Lerp(transform.position, desiredPos, followSpeed * Time.deltaTime);
        transform.rotation = Quaternion.Euler(angle, 0, 0);
    }
}
```

---

## 7. WebGL 构建优化

### 7.1 包体积控制

| 优化策略 | 预估收益 | 说明 |
|:---------|:---------|:-----|
| **代码剥离** (Managed Stripping: High) | -30% 代码体积 | 移除未引用的 .NET 代码 |
| **Crunch 纹理压缩** | -60% 纹理体积 | 有损但视觉影响小 |
| **ASTC/ETC2 压缩** | -50% 纹理 | WebGL2 原生支持 |
| **Mesh 压缩** (High) | -40% 模型体积 | Unity 内置 |
| **Asset Bundle 分包** | 首屏 < 5MB | 地图/建筑首屏；英雄模型按需加载 |
| **Addressables 远程资源** | 减小初始包 | 英雄模型/特效远程 CDN 加载 |
| **Brotli 压缩** (.br) | -15% vs gzip | 需服务器配置 Content-Encoding |
| **关闭异常支持** | -5% | Player Settings → WebGL → 关闭 C++ 异常 |

**目标包体积**：
| 资源 | 体积（Brotli） |
|:-----|:---------------|
| WASM + 框架 | ~3MB |
| 核心场景（地图/建筑） | ~2MB |
| 首屏英雄（2个） | ~1MB |
| 合计首屏 | **~6MB** |
| 剩余英雄（按需加载） | ~4MB |
| 总计 | **~10MB** |

### 7.2 运行时性能

| 优化策略 | 说明 |
|:---------|:-----|
| **Static Batching** | 地形/建筑/围栏等静态物体合批 |
| **GPU Instancing** | 雪花/粒子 Instanced Rendering |
| **LOD Group** | 英雄 2 级 LOD，远处降面 |
| **Object Pooling** | 弹道/粒子/伤害数字对象池 |
| **Occlusion Culling** | 烘焙遮挡剔除（对嚎哭深渊效果有限） |
| **烘焙光照** | Lightmap 替代实时光照计算 |
| **限制 Draw Call** | 目标 < 100 Draw Call/帧 |
| **帧率限制** | Application.targetFrameRate = 60 |
| **内存预算** | 256MB WASM 堆，动态监控 |

### 7.3 WebGL 特殊限制与规避

| 限制 | 影响 | 规避方案 |
|:-----|:-----|:---------|
| 无多线程 | Job System/Burst 部分失效 | 避免 CPU 密集计算，游戏逻辑在服务端 |
| 无 Compute Shader | VFX Graph 部分节点不可用 | 使用 Shuriken 粒子系统替代 |
| 内存不可动态扩展 | 初始堆需预设 | 设置 256MB 初始堆，资源加载后及时释放 |
| 音频延迟 | Web Audio API 限制 | 预加载音频，用户首次交互后启动 AudioContext |
| 无本地文件访问 | PlayerPrefs 用 IndexedDB | 不影响（游戏状态在服务端） |
| 移动端性能 | iOS Safari WASM 性能差 | MVP 仅支持 PC Chrome/Firefox/Edge |

---

## 8. 开发工作流

### 8.1 环境搭建

```
所需软件：
- Unity 2022.3 LTS (WebGL Build Support 模块)
- Visual Studio 2022 / Rider (C# IDE)
- Blender 3.6+ (模型编辑，可选)
- Node.js 18+ (前端)

Unity 包依赖：
- Universal RP 14.x
- TextMeshPro
- Input System
- Addressables (资源分包)
- Cinemachine (可选，高级摄像机)
```

### 8.2 开发与调试

| 阶段 | 工具 | 说明 |
|:-----|:-----|:-----|
| C# 开发 | Unity Editor + VS/Rider | Play Mode 即时预览 |
| WebGL 调试 | Chrome DevTools + Unity Console 重定向 | `Debug.Log` → `console.log` |
| 性能分析 | Unity Profiler (Remote) + Chrome Performance | CPU/GPU/内存 |
| JS 桥接调试 | Chrome Console + Unity SendMessage | 双向消息验证 |
| 自动构建 | Unity CLI `-batchmode -buildTarget WebGL` | CI/CD 集成 |

### 8.3 部署流程

```
1. Unity Build → WebGL 产物 (Build/ 目录)
   ├── Build.wasm.br        (WASM 二进制)
   ├── Build.framework.js.br (框架脚本)
   ├── Build.data.br         (资源数据)
   └── Build.loader.js       (加载器)

2. 复制产物到前端项目
   cp -r Build/ frontend/public/unity/

3. React 页面嵌入
   <script src="/unity/Build.loader.js" />
   createUnityInstance(canvas, {
     dataUrl: "/unity/Build.data.br",
     frameworkUrl: "/unity/Build.framework.js.br",
     codeUrl: "/unity/Build.wasm.br",
     companyName: "MoYuStudio",
     productName: "MoYuBattle",
   })

4. Nginx 配置 Brotli Content-Encoding
   location /unity/ {
     add_header Content-Encoding br;
     types { application/wasm wasm; }
   }
```

---

## 9. 与主方案（Three.js）对比决策矩阵

| 评估维度 | Three.js（主方案） | Unity WebGL（备选） | 权重 |
|:---------|:------------------|:-------------------|:-----|
| **画面品质** | ★★★☆☆ 良好 | ★★★★★ 优秀 | 高 |
| **3D 模型工作流** | ★★★☆☆ 代码加载 | ★★★★★ 编辑器拖拽 | 高 |
| **动画系统** | ★★★☆☆ 手写状态机 | ★★★★★ Mecanim 可视化 | 高 |
| **首屏加载** | ★★★★★ ~200KB | ★★☆☆☆ ~6MB | 中 |
| **React 集成** | ★★★★★ 原生 | ★★☆☆☆ 桥接复杂 | 高 |
| **开发迭代速度** | ★★★★☆ Web HMR | ★★☆☆☆ 构建慢 | 中 |
| **包体积** | ★★★★★ 极小 | ★★☆☆☆ 较大 | 中 |
| **团队技能** | ★★★☆☆ 需学 Three.js | ★★★☆☆ 需学 Unity | 中 |
| **移动端兼容** | ★★★★☆ | ★★☆☆☆ | 低 |
| **后期扩展性** | ★★★☆☆ | ★★★★★ | 中 |

### 切换建议

在以下情况下建议切换到 Unity WebGL：

1. **Three.js 画面瓶颈**：在 Three.js 原型验证中，画面品质无法达到团队/用户预期（低多边形几何体英雄不被接受）
2. **动画复杂度升级**：需要复杂的动画混合树（如移动+攻击同时播放、方向性混合）
3. **特效需求升级**：需要大量粒子特效、屏幕后处理，Three.js 手写成本过高
4. **团队有 Unity 经验**：团队中有熟悉 Unity 的成员，可加速开发
5. **首屏加载可接受**：目标用户网络环境良好（如企业内网），6MB 加载无压力

在以下情况下**不建议**切换：
1. 首屏加载性能是硬指标（要求 < 3MB / < 3秒）
2. 需要深度 React 集成（如 HUD 组件大量复用现有 Ant Design 组件）
3. 移动端浏览器是重要目标平台
4. 团队完全无 Unity 经验且排期紧张

---

## 10. 迁移路径（从 Three.js 切换到 Unity）

若决定切换，建议按以下步骤：

| 步骤 | 任务 | 周期 |
|:-----|:-----|:-----|
| 1 | Unity 环境搭建 + URP 配置 + WebGL 模板 | 2天 |
| 2 | 嚎哭深渊地图搭建（桥面/深渊/围栏/雪花） | 3天 |
| 3 | 防御塔/水晶枢纽预制体 + 光照烘焙 | 2天 |
| 4 | 2 个测试英雄（模型+动画+Mecanim） | 3天 |
| 5 | JS ↔ Unity 桥接 + WebSocket 对接 | 2天 |
| 6 | MOBA 摄像机 + 键鼠输入 | 1天 |
| 7 | React 嵌入 + HUD 覆盖层 | 2天 |
| 8 | WebGL 构建优化（包体/性能） | 2天 |
| **总计** | | **~17天（3.5周）** |

> 迁移周期与 Three.js Phase 1 相当，但后续 Phase 2-4 因 Unity 工具链优势可加速约 30%。

---

## 11. 风险评估

| 风险 | 概率 | 影响 | 应对 |
|:-----|:-----|:-----|:-----|
| WebGL 包体 > 10MB | 中 | 首屏慢 | Addressables 分包 + CDN + Loading 动画 |
| iOS Safari 不兼容 | 高 | 移动端不可用 | MVP 限 PC；后续考虑 Unity WebGPU |
| JS ↔ Unity 通信延迟 | 低 | HUD 更新滞后 | 关键 HUD 在 Unity UGUI 内实现 |
| WASM 内存 OOM | 中 | 低端设备崩溃 | 资源精细管理 + 内存监控 + 降级提示 |
| Unity License 限制 | 低 | 免费版可商用 | Personal 版年收入 < $100K 免费 |
| 构建迭代慢 | 高 | 开发效率降低 | 增量构建 + Unity 编辑器内调试为主 |

---

> **文档结束** — 本文档为 Unity WebGL 备选方案的完整技术规格。如 Three.js 主方案达到预期，本方案可作为后续"画面品质升级"的储备路线。
