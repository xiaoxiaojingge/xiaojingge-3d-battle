---
name: threejs-skill
description: Three.js 开发总控技能 - 提供完整的 Three.js 3D 开发指导，协调 10 个专业子技能的使用。适用于任何 Three.js 项目开发、场景构建、性能优化等场景。
---

# Three.js 开发总控

## 任务目标

本技能用于指导完整的 Three.js 3D 应用开发流程，协调不同开发阶段所需的子技能：

- **项目初始化**：场景搭建、渲染器配置
- **内容创建**：几何体、材质、灯光
- **资源管理**：模型加载、纹理处理
- **动态效果**：动画、着色器、后处理
- **交互开发**：用户输入、对象选择、相机控制

## 子技能索引

以下是 10 个专业子技能的快速索引，根据开发需求选择加载：

### 基础架构
1. **threejs-fundamentals** (基础)
   - 场景设置、相机、渲染器配置
   - Object3D 层级、坐标系统、变换
   - **使用场景**：项目初始化、搭建基础框架

2. **threejs-interaction** (交互)
   - 射线检测、相机控制
   - 鼠标/触摸输入、对象选择
   - **使用场景**：添加用户交互、实现点击检测、控制相机

### 内容构建
3. **threejs-geometry** (几何)
   - 内置形状、BufferGeometry、自定义几何体
   - 实例化渲染优化
   - **使用场景**：创建 3D 形状、处理顶点、构建自定义网格

4. **threejs-materials** (材质)
   - PBR 材质、基础/Phong 材质、着色器材质
   - 材质属性、纹理集成
   - **使用场景**：设置网格外观、优化材质性能、创建自定义着色器

5. **threejs-lighting** (灯光)
   - 灯光类型、阴影、环境光照
   - 光照性能优化
   - **使用场景**：添加灯光、配置阴影、设置 IBL

### 资源加载
6. **threejs-textures** (纹理)
   - 纹理类型、UV 映射、环境贴图
   - 纹理优化
   - **使用场景**：处理图片、UV 坐标、立方体贴图、HDR 环境

7. **threejs-loaders** (加载)
   - GLTF/GLB 加载、纹理加载
   - 异步模式、缓存管理
   - **使用场景**：加载 3D 模型、纹理、HDR 环境、管理加载进度

### 高级特效
8. **threejs-animation** (动画)
   - 关键帧动画、骨骼动画
   - 形态目标、动画混合
   - **使用场景**：播放 GLTF 动画、创建程序化运动、混合动画

9. **threejs-shaders** (着色器)
   - GLSL 基础、ShaderMaterial
   - Uniforms、自定义效果
   - **使用场景**：创建自定义视觉效果、修改顶点、编写片段着色器

10. **threejs-postprocessing** (后处理)
    - EffectComposer、bloom、景深
    - 屏幕效果、自定义屏幕空间着色器
    - **使用场景**：添加视觉特效、调色、模糊、发光、创建屏幕空间着色器

## 开发流程指导

### 阶段 1：项目初始化
```
目标：搭建可运行的 Three.js 场景

必需技能：threejs-fundamentals

任务清单：
1. 创建 Scene、Camera、Renderer
2. 配置渲染器参数（抗锯齿、阴影等）
3. 设置基本的动画循环
4. 实现窗口大小自适应
```

### 阶段 2：添加基础内容
```
目标：创建可见的 3D 对象

必需技能：threejs-fundamentals, threejs-geometry, threejs-materials, threejs-lighting

任务清单：
1. 使用 threejs-geometry 创建几何体（或 threejs-loaders 加载模型）
2. 使用 threejs-materials 配置材质
3. 使用 threejs-lighting 添加灯光
4. 将对象添加到场景
```

### 阶段 3：丰富视觉效果
```
目标：提升视觉质量和真实感

可选技能（按需选择）：
- 添加纹理：threejs-textures
- 环境光照：threejs-lighting（环境贴图）
- 后处理效果：threejs-postprocessing

任务清单：
1. 为材质添加纹理（threejs-textures）
2. 配置环境光照和反射（threejs-lighting + threejs-textures）
3. 添加后处理效果如泛光（threejs-postprocessing）
```

### 阶段 4：添加交互
```
目标：实现用户控制

必需技能：threejs-interaction

可选技能：threejs-animation（交互触发动画）

任务清单：
1. 添加射线检测实现对象选择
2. 配置相机控制器（OrbitControls 等）
3. 实现鼠标/触摸事件处理
4. 将交互与动画联动（threejs-animation）
```

### 阶段 5：高级特性（可选）
```
目标：实现高级特效和优化

按需选择：
- 自定义着色器：threejs-shaders
- 后处理特效：threejs-postprocessing
- 复杂动画：threejs-animation
- 资源优化：threejs-loaders（缓存、压缩）

任务清单：
1. 编写自定义着色器实现独特效果
2. 配置多通道后处理管线
3. 实现动画混合和状态机
4. 优化加载性能和缓存策略
```

## 常见组合场景

### 场景 1：静态产品展示
```
技能组合：fundamentals + geometry + materials + lighting + textures + interaction

适用：电商产品展示、博物馆展品
重点：高质量材质、环境光照、相机控制
```

### 场景 2：交互式游戏
```
技能组合：fundamentals + loaders + animation + interaction + shaders

适用：小游戏、互动体验
重点：模型加载、动画播放、实时交互、自定义着色器
```

### 场景 3：数据可视化
```
技能组合：fundamentals + geometry + materials + interaction + postprocessing

适用：图表、3D 地图
重点：几何体创建、材质定制、交互选择、后处理特效
```

### 场景 4：电影级视觉
```
技能组合：fundamentals + loaders + lighting + textures + postprocessing + shaders

适用：展示视频、高端产品展示
重点：高精度模型、环境光照、后期调色、自定义特效
```

### 场景 5：建筑可视化
```
技能组合：fundamentals + loaders + lighting + textures + interaction + animation

适用：建筑漫游、室内设计
重点：大型场景加载、逼真光照、纹理映射、路径动画
```

## 性能优化建议

### 基础优化
1. **渲染器配置**（fundamentals）
   - 合理设置像素比（限制为 2）
   - 启用抗锯齿但权衡性能
   - 使用正确的色调映射

2. **几何体优化**（geometry）
   - 使用实例化渲染处理大量相同对象
   - 合并静态几何体减少 draw calls
   - 合理控制几何体面数

3. **材质优化**（materials）
   - 共享材质实例
   - 合理使用透明度（避免过多半透明对象）
   - 选择合适的材质类型

4. **光照优化**（lighting）
   - 限制动态光源数量
   - 使用烘焙光照贴图
   - 合理配置阴影参数

### 进阶优化
5. **纹理优化**（textures）
   - 使用合适的纹理格式
   - 启用 mipmap
   - 合理设置纹理过滤

6. **后处理优化**（postprocessing）
   - 限制后处理通道数量
   - 降低渲染分辨率
   - 合理使用抗锯齿

7. **加载优化**（loaders）
   - 使用压缩模型格式（Draco）
   - 实现渐进式加载
   - 使用加载管理器

## 开发检查清单

### 项目启动
- [ ] 场景、相机、渲染器已创建
- [ ] 动画循环已设置
- [ ] 窗口大小自适应已实现
- [ ] 基础灯光已添加

### 内容开发
- [ ] 几何体/模型已创建或加载
- [ ] 材质已配置并应用
- [ ] 纹理已正确映射
- [ ] 光照效果已调整

### 功能实现
- [ ] 所需交互已实现
- [ ] 动画已配置并播放
- [ ] 后处理效果已添加
- [ ] 自定义着色器已测试

### 性能与质量
- [ ] 帧率达标（60fps 目标）
- [ ] 内存使用合理
- [ ] 无明显视觉错误
- [ ] 跨浏览器测试通过

## 技能加载策略

### 智能体使用建议

1. **根据需求动态加载**：
   - 用户提到"创建场景" → 加载 threejs-fundamentals
   - 用户提到"加载模型" → 加载 threejs-loaders
   - 用户提到"添加灯光" → 加载 threejs-lighting
   - 用户提到"播放动画" → 加载 threejs-animation
   - 用户提到"添加特效" → 加载 threejs-postprocessing / threejs-shaders

2. **组合使用场景**：
   - 当用户需求涉及多个领域时，按流程加载相关技能
   - 例如："创建一个可交互的产品展示" → fundamentals + geometry + materials + lighting + interaction

3. **优先级建议**：
   - 基础优先：fundamentals 是所有开发的基础
   - 按需扩展：根据具体需求加载其他技能
   - 深度优化：遇到性能问题时关注 lighting、materials、geometry 的优化建议

## 注意事项

- 本技能仅提供指导和索引，具体 API 参考和代码示例请加载对应的子技能
- Three.js 版本：基于 r160+ 开发，确保 API 兼容性
- 浏览器支持：现代浏览器需支持 WebGL
- 性能考虑：移动端需特别注意性能优化
- 学习路径：建议按"基础架构 → 内容构建 → 资源加载 → 高级特效"的顺序学习

## 版本信息

- Three.js：r160+
- 技能集合版本：1.0
- 更新日期：2024
