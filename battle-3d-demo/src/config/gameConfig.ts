import type { EmoteDefinition, HeroActionSlot, HeroAnimationConfig, HeroAssetConfig, HeroLineupConfig, HeroOverheadConfig, HeroVoiceConfig, HeroVoiceSlot, HeroWheelVoice, MapConfig } from '../types/game';
import { getAssetDirectory, isHttpUrl, resolveAssetUrl } from '../utils/assetUrl';
import { MULTIPLAYER_RUNTIME_CONFIG, MULTIPLAYER_SPAWN_LAYOUTS, MULTIPLAYER_TEST_LINEUP } from './multiplayerShared.js';

/**
 * 默认动画状态别名表。
 * 作用：把“模型里真实存在的动画片段名关键字”归一到统一标准状态。
 * 读取方式可以理解为“右边命中后，映射成左边的标准状态”。
 *
 * 例如：
 * - 某个模型的片段名叫 `Idle`、`idle_loop`、`Stand`，都会尝试归到 `idle`
 * - 某个模型的片段名叫 `Standby`、`wait`，都会尝试归到 `standby`
 * - 某个模型的片段名叫 `Run2`、`walk_forward`，都会尝试归到 `run`
 *
 * 这个表解决的是“识别问题”：告诉系统某个片段属于哪一类状态。
 * 它不决定最终优先播放哪个片段，只负责把候选片段先分类。
 * 
 * 
 */
const DEFAULT_STATE_ALIASES: Required<HeroAnimationConfig>['stateAliases'] = {
  idle: ['Idle', 'idle', 'Idle1', 'stand'],
  standby: ['Standby', 'standby', 'wait', 'relax', 'rest'],
  run: ['Run2', 'Run', 'run', 'walk', 'move'],
  attack: ['Attack1', 'attack', 'hit'],
  cast: ['Spell1A', 'Spell', 'cast', 'spell', 'skill'],
  death: ['Death', 'death', 'die', 'dead'],
};

/**
 * 默认标准状态到首选动画片段名的映射。
 * 作用：当某个标准状态已经通过 `DEFAULT_STATE_ALIASES` 找到多个候选片段后，
 * 再告诉系统“这一类里我最想优先用哪一个片段名”。
 *
 * 例如：
 * - `run` 可能同时匹配到 `Run`、`Run2`、`Run_Fast`
 * - 这里把 `run` 的首选设成 `Run2`
 * - 那么系统会优先尝试 `Run2`，找不到时才退回同类里的其他候选
 *
 * 这个表解决的是“优先级问题”：
 * 它不负责分类，而是在已经知道状态类别后，指定最优先片段。
 */
const DEFAULT_STATE_CLIPS: Required<HeroAnimationConfig>['stateClips'] = {
  /** 待机状态首选片段。 */
  idle: 'Idle',
  /** 长时间静止后的待机模式首选片段。 */
  standby: 'Standby',
  /** 移动状态首选片段。 */
  run: 'Run',
  /** 攻击状态首选片段。 */
  attack: 'Attack',
  /** 施法状态首选片段。 */
  cast: 'Cast',
  /** 死亡状态首选片段。 */
  death: 'Death',
};

/** 默认进入待机模式所需的静止时长。 */
const DEFAULT_STANDBY_DELAY_MS = 15000;

/**
 * 英雄资源若直接传入项目内静态路径时允许的前缀。
 */
const DIRECT_ASSET_PATH_PATTERN = /^(\/|\.\/|\.\.\/)/;

/**
 * 默认英雄语音文件命名模板。
 * 约定所有英雄都优先从各自目录下的 `voices` 子目录读取这些文件名；
 * 如果后续接入远程 CDN，也可以直接在英雄配置里改成完整 URL。
 */
const DEFAULT_HERO_VOICE_FILES: Partial<Record<HeroVoiceSlot, string[]>> = {
  /** 基础普攻语音文件列表。 */
  basicAttack: ['basic-attack-1.mp3'],
  /** Q 技能语音文件列表。 */
  q: ['q-1.mp3'],
  /** W 技能语音文件列表。 */
  w: ['w-1.mp3'],
  /** E 技能语音文件列表。 */
  e: ['e-1.mp3'],
  /** R 技能语音文件列表。 */
  r: ['r-1.mp3'],
  /** 回城语音文件列表。 */
  recall: ['recall-1.mp3'],
  /** 角色静止时的待机语音文件列表（已禁用，不再自动调度）。 */
  idle: [],
};

/**
 * 英雄语音槽位遍历顺序。
 */
const HERO_VOICE_SLOTS: HeroVoiceSlot[] = ['basicAttack', 'q', 'w', 'e', 'r', 'recall'];

/**
 * 公共默认动作槽位到动画片段名的映射模板。
 * 作用：先提供一套“通用默认值”，把“业务层动作槽位”映射到“模型里的具体动作片段名”。
 *
 * 例如：
 * - 业务层按下 Q，只知道你触发了 `q` 这个技能槽位
 * - 但模型文件里真正的片段名可能叫 `Spell1A`
 * - 这里就负责把 `q -> Spell1A` 对上
 *
 * 要特别注意：这个变量只是“公共默认模板”，不是“所有英雄最终都只用这一套”。
 * 每个英雄仍然应该在自己的资源配置里拥有一份最终动作映射；如果某个英雄片段名不同，
 * 就在该英雄自己的 `animations.actionClips` 上覆盖，而不是改业务逻辑。
 *
 * 这个表解决的是“技能/普攻按钮该播哪个片段”的问题。
 * 和 `DEFAULT_STATE_ALIASES` / `DEFAULT_STATE_CLIPS` 的区别是：
 * - `DEFAULT_STATE_ALIASES`：给 idle / run / death 这类标准状态做分类
 * - `DEFAULT_STATE_CLIPS`：在某个标准状态内部指定优先片段
 * - `DEFAULT_ACTION_CLIPS`：给 q / w / e / r / 普攻 / 回城 这类业务动作指定片段
 */
const DEFAULT_ACTION_CLIPS: Record<HeroActionSlot, string> = {
  /** 基础普攻动作片段名。 */
  basicAttack: 'Attack',
  /** Q 技能动作片段名。 */
  q: 'Spell1',
  /** W 技能动作片名。 */
  w: 'Spell2',
  /** E 技能动作片段名。 */
  e: 'Spell3',
  /** R 技能动作片段名。 */
  r: 'Spell4',
  /** 回城动作片段名。 */
  recall: 'Recall',
};

/**
 * 默认动作槽位到动画播放速率倍率的映射。
 * 主要用于调试技能动作快慢。
 *
 * 例如：
 * - `q: 1.25` 表示 Q 动画按 1.25 倍速播放
 * - `r: 0.85` 表示 R 动画按 0.85 倍速播放
 * - `1` 表示保持模型原始动画速度不变
 */
const DEFAULT_ACTION_PLAYBACK_RATES: Partial<Record<HeroActionSlot, number>> = {
  /** 基础普攻默认原速播放。 */
  basicAttack: 1,
  /** Q 技能默认原速播放。 */
  q: 1,
  /** W 技能默认原速播放。 */
  w: 1,
  /** E 技能默认原速播放。 */
  e: 1,
  /** R 技能默认原速播放。 */
  r: 1,
  /** 回城默认原速播放。 */
  recall: 1,
};

/**
 * 默认动作持续时间配置。
 * 主要用于动作播放期间的移动锁定与动作结束后的状态回落判定。
 * 如果指定英雄设定，请到对应地方设置
 */
const DEFAULT_ACTION_DURATIONS_MS: Partial<Record<HeroActionSlot, number>> = {
  /** 基础普攻持续时长。 */
  basicAttack: 450,
  /** Q 技能持续时长。 */
  q: 1100,
  /** W 技能持续时长。 */
  w: 520,
  /** E 技能持续时长。 */
  e: 420,
  /** R 技能持续时长。 */
  r: 760,
  /** 回城持续时长。 */
  recall: 1200,
};

/**
 * 默认动作期间的移动锁定开关表。
 * 用于统一规定哪些动作播放时禁止角色继续移动。
 * 如果指定英雄设定，请到对应地方设置
 */
const DEFAULT_ACTION_MOVEMENT_LOCKS: Partial<Record<HeroActionSlot, boolean>> = {
  /** 基础普攻期间锁定移动。 */
  basicAttack: true,
  /** Q 技能期间锁定移动。 */
  q: true,
  /** W 技能期间锁定移动。 */
  w: true,
  /** E 技能期间锁定移动。 */
  e: true,
  /** R 技能期间锁定移动。 */
  r: true,
  /** 回城期间锁定移动。 */
  recall: true,
};

/** 合并默认动画模板与英雄级覆盖配置。 */
function mergeHeroAnimationConfig(overrides?: HeroAnimationConfig): HeroAnimationConfig {
  return {
    stateAliases: {
      ...DEFAULT_STATE_ALIASES,
      ...overrides?.stateAliases,
    },
    stateClips: {
      ...DEFAULT_STATE_CLIPS,
      ...overrides?.stateClips,
    },
    actionClips: {
      ...DEFAULT_ACTION_CLIPS,
      ...overrides?.actionClips,
    },
    actionPlaybackRates: {
      ...DEFAULT_ACTION_PLAYBACK_RATES,
      ...overrides?.actionPlaybackRates,
    },
    actionDurationsMs: {
      ...DEFAULT_ACTION_DURATIONS_MS,
      ...overrides?.actionDurationsMs,
    },
    actionMovementLocks: {
      ...DEFAULT_ACTION_MOVEMENT_LOCKS,
      ...overrides?.actionMovementLocks,
    },
    standbyDelayMs: overrides?.standbyDelayMs ?? DEFAULT_STANDBY_DELAY_MS,
  };
}

/**
 * 规范化英雄语音配置。
 * 只在明确提供语音配置时注入默认的待机语音随机间隔与音量。
 */
function mergeHeroVoiceConfig(overrides?: HeroVoiceConfig): HeroVoiceConfig | undefined {
  if (!overrides) {
    return undefined;
  }

  return {
    ...overrides,
    volume: overrides.volume ?? 1,
  };
}

/**
 * 生成英雄模型资源地址。
 * 这里既兼容本地静态资源，也兼容直接传入任意域名的远程 URL。
 */
function createHeroModelUrl(heroId: string, modelFileName = 'classic.glb'): string {
  if (isHttpUrl(modelFileName)) {
    return modelFileName;
  }

  if (DIRECT_ASSET_PATH_PATTERN.test(modelFileName)) {
    return resolveAssetUrl(modelFileName) ?? modelFileName;
  }

  const localModelPath = `/models/heroes/${heroId}/${modelFileName}`;
  return resolveAssetUrl(localModelPath) ?? localModelPath;
}

/**
 * 生成英雄语音资源地址。
 * 这里同样兼容本地静态资源路径与任意域名的远程 URL。
 */
function createHeroVoiceUrl(heroId: string, voiceFilePath: string): string {
  if (isHttpUrl(voiceFilePath)) {
    return voiceFilePath;
  }

  if (DIRECT_ASSET_PATH_PATTERN.test(voiceFilePath)) {
    return resolveAssetUrl(voiceFilePath) ?? voiceFilePath;
  }

  const localVoicePath = `/models/heroes/${heroId}/voices/${voiceFilePath}`;
  return resolveAssetUrl(localVoicePath) ?? localVoicePath;
}

/**
 * 规范化英雄语音配置。
 * 默认会把 `Q/W/E/R/基础普攻/回城/待机` 都映射到各自明确的语音槽位，避免串槽；
 * 如果英雄自己传入了覆盖配置，则优先使用覆盖值，同时继续兼容本地路径和远程 URL。
 */
function createHeroVoiceConfig(heroId: string, overrides?: HeroVoiceConfig): HeroVoiceConfig {
  const resolvedVoiceConfig: HeroVoiceConfig = {
    volume: overrides?.volume,
  };

  HERO_VOICE_SLOTS.forEach((slot) => {
    const files = overrides?.[slot] ?? DEFAULT_HERO_VOICE_FILES[slot];
    if (!files?.length) {
      return;
    }

    resolvedVoiceConfig[slot] = files.map((file) => createHeroVoiceUrl(heroId, file));
  });

  /** T轮盘自定义语音列表：将每项中的相对路径解析为完整 URL。 */
  if (overrides?.customWheel?.length) {
    resolvedVoiceConfig.customWheel = overrides.customWheel.map((item) => ({
      ...item,
      voiceUrls: item.voiceUrls.map((file) => createHeroVoiceUrl(heroId, file)),
    }));
  }

  return resolvedVoiceConfig;
}

/** 单个英雄资源构建参数。 */
type HeroAssetBuildOptions = {
  /** 英雄自己的动画覆盖配置。 */
  animations?: HeroAnimationConfig;
  /** 当前资源使用的模型路径，可为本地路径或网络 URL。 */
  modelPath?: string;
  /** 当前资源使用的贴图基础目录，可为本地路径或网络 URL。 */
  textureBasePath?: string;
  /** 当前英雄的语音配置。 */
  voices?: HeroVoiceConfig;
  /** 模型相对统一英雄基准高度的尺寸倍率。 */
  modelScale?: number;
  /** 模型归一化后的额外落地偏移量。 */
  groundOffsetY?: number;
  /** 英雄自己的头顶 HUD 挂点覆盖配置。 */
  overhead?: HeroOverheadConfig;
};

/**
 * 生成单个英雄的默认资源配置。
 * 创建时直接绑定当前使用的一套模型、贴图、动画与语音资源。
 */
function createHeroAsset(heroId: string, label = '英雄Label', options: HeroAssetBuildOptions = {}): HeroAssetConfig {
  const modelPath = options.modelPath ?? createHeroModelUrl(heroId);
  const textureBasePath = options.textureBasePath ?? getAssetDirectory(modelPath) ?? resolveAssetUrl(`/models/heroes/${heroId}/`) ?? `/models/heroes/${heroId}/`;
  const voiceConfig = createHeroVoiceConfig(heroId, options.voices);
  return {
    /** 当前资源展示名称。 */
    label,
    /** 模型文件路径。 */
    modelPath,
    /** 贴图基础目录。 */
    textureBasePath,
    /** 模型相对统一英雄基准高度的尺寸倍率。 */
    modelScale: options.modelScale,
    /** 模型归一化后的额外落地偏移量。 */
    groundOffsetY: options.groundOffsetY,
    animations: mergeHeroAnimationConfig(options.animations),
    /** 英雄语音配置。 */
    voices: mergeHeroVoiceConfig(voiceConfig),
    /** 英雄头顶 HUD 挂点覆盖配置。 */
    overhead: options.overhead,
  };
}

/**
 * 地图基础配置。
 * 统一管理地图尺寸、可走范围、建筑布局和出生点位置。
 */
const MAP_CONFIG_VALUE: MapConfig = {
  /** 地图整体宽度。 */
  width: 160,
  /** 地图整体纵深。 */
  depth: 54,
  /** 中央桥面的有效宽度。 */
  bridgeWidth: 40,
  /** 中央桥面的有效长度。 */
  bridgeLength: 270,
  playableBounds: {
    /** 英雄可走区域最小 X。 */
    minX: -130,
    /** 英雄可走区域最大 X。 */
    maxX: 130,
    /**
     * 英雄可走区域最小 Z。
     * 该值直接决定角色最多能贴近桥体南侧边缘到什么程度。
     */
    minZ: -19.6,
    /**
     * 英雄可走区域最大 Z。
     * 与 minZ 成镜像关系。
     */
    maxZ: 19.6,
  },
  towers: [
    /** 蓝队外塔位置。 */
    { position: [-25, 0, 0], team: 'blue', type: 'outer' },
    /** 蓝队内塔位置。 */
    { position: [-55, 0, 0], team: 'blue', type: 'inner' },
    /** 蓝队左门牙塔位置。 */
    { position: [-100, 0, -5.4], team: 'blue', type: 'nexusGuard' },
    /** 蓝队右门牙塔位置。 */
    { position: [-100, 0, 5.4], team: 'blue', type: 'nexusGuard' },
    /** 红队外塔位置。 */
    { position: [25, 0, 0], team: 'red', type: 'outer' },
    /** 红队内塔位置。 */
    { position: [55, 0, 0], team: 'red', type: 'inner' },
    /** 红队左门牙塔位置。 */
    { position: [100, 0, -5.4], team: 'red', type: 'nexusGuard' },
    /** 红队右门牙塔位置。 */
    { position: [100, 0, 5.4], team: 'red', type: 'nexusGuard' },

  ],
  nexuses: [
    /** 蓝队水晶枢纽位置。 */
    { position: [-110, 0, 0], team: 'blue' },
    /** 红队水晶枢纽位置。 */
    { position: [115, 0, 0], team: 'red' },
  ],
  healthRelics: [
    /** 中路左侧生命遗迹位置（靠近蓝方外塔）。 */
    { position: [-10, 0, 15] },
    /** 中路右侧生命遗迹位置（靠近红方外塔）。 */
    { position: [10, 0, -15] },
    /** 蓝方内塔附近生命遗迹位置。 */
    { position: [-45, 0, -15] },
    /** 红方内塔附近生命遗迹位置。 */
    { position: [45, 0, 15] },
  ],
  inhibitors: [
    /** 蓝方小水晶（兵营水晶）位置，位于蓝方内塔和门牙塔之间。 */
    { position: [-80, 0, 0], team: 'blue' },
    /** 红方小水晶（兵营水晶）位置，位于红方内塔和门牙塔之间。 */
    { position: [80, 0, 0], team: 'red' },
  ],
  /** 双方初始编队落点。 */
  spawnLayouts: {
    /** 蓝队初始编队。 */
    blue: MULTIPLAYER_SPAWN_LAYOUTS.blue,
    /** 红队初始编队。 */
    red: MULTIPLAYER_SPAWN_LAYOUTS.red,
  },
};

/**
 * 游戏主配置总表。
 * 所有可动态调整的地图、镜头、HUD、环境、英雄资源与调试参数都优先收口在这里。
 */
export const GAME_CONFIG = {
  /** 地图主配置。 */
  map: MAP_CONFIG_VALUE,
  camera: {
    /** 相机视野角度。 */
    fov: 50,
    /** 相机近裁剪面。 */
    near: 0.1,
    /** 相机远裁剪面。 */
    far: 500,
    /** 初始是否锁定到本地玩家。 */
    defaultLocked: true,
    /** 初始观察目标点。 */
    initialTarget: [0, 0, 0] as [number, number, number],
    /** 默认斜视角偏移量。 */
    baseOffset: [-22, 34, 22] as [number, number, number],
    /** 初始镜头缩放值。 */
    initialZoom: 25,
    /** 是否启用开场远→近推镜动画。 */
    introEnabled: true,
    /** 开场推镜起始缩放值（远景），数值越大镜头越远。 */
    introStartZoom: 180,
    /** 开场推镜插值速率，值越大推进越快（每秒指数衰减系数）。 */
    introSpeed: 1,
    /** 玩家镜头锁定跟随开关快捷键（类似英雄联盟 Y 键）。 */
    lockToggleKey: 'KeyY',
    /** 左键拖动屏幕时是否自动解除玩家镜头跟随锁定。 */
    dragUnlocksCamera: true,
    /** 滚轮缩放最小值。 */
    minZoom: 10,
    /** 滚轮缩放最大值。 */
    maxZoom: 35,
    /** 每次滚轮缩放步进。 */
    zoomStep: 2,
    /** 左键拖动镜头时的基础平移速度。 */
    dragPanSpeed: 0.01,
    /** 边缘滚屏触发区域宽度，单位像素。 */
    edgePanMargin: 24,
    /** 边缘滚屏基础速度。 */
    edgePanSpeed: 16,
    /** 导播自由视角是否允许边缘滚屏。 */
    enableEdgePan: true,
    /** 目标点插值速度。 */
    targetLerp: 8,
    /** 相机位置插值速度。 */
    positionLerp: 7,
    bounds: {
      /** 自由镜头最小 X 边界。 */
      minX: -115,
      /** 自由镜头最大 X 边界。 */
      maxX: 115,
      /** 自由镜头最小 Z 边界。 */
      minZ: -26,
      /** 自由镜头最大 Z 边界。 */
      maxZ: 26,
    },
  },

  input: {
    rightClickIndicator: {
      /** 右键移动指示器显示时长。 */
      durationMs: 850,
      cursor: {
        /** 是否启用右键指针素材配置。 */
        enabled: true,
        /** 常态鼠标指针资源路径。 */
        defaultPath: '/cursors/summoner/normal.cur',
        /** 右键点击后的短暂反馈指针资源路径。 */
        clickPath: '/cursors/summoner/link.cur',
        /** 指针热点 X 坐标。 */
        hotspotX: 6,
        /** 指针热点 Y 坐标。 */
        hotspotY: 4,
        /** 点击反馈持续时长。 */
        clickFeedbackMs: 160,
        /** 自定义指针失效时回退到的 CSS 指针值。 */
        fallback: 'auto',
      },
      ground: {
        /** 地面落点标识模型路径。 */
        modelPath: undefined as string | undefined,
        /** 地面标识模型目标高度。 */
        targetHeight: 1.2,
        /** 地面标识模型待机动画片段名。 */
        animationClipName: undefined as string | undefined,
        /** 地面标识基础抬升高度，避免与地面闪烁。 */
        offsetY: 0.045,
        /** 地面标识外环半径。 */
        outerRadius: 0.55,
        /** 地面标识内环半径。 */
        innerRadius: 0.54,
        /** 落点中心亮斑半径。 */
        centerRadius: 0.2,
        /** 外环扩散的最大倍率。 */
        rippleScale: 1.38,
        /** 第一层外扩光环半径。 */
        rippleOuterRadius: 0.6,
        /** 第二层外扩光环半径。 */
        rippleFarOuterRadius: 0.7,
        /** 地面标识主色。 */
        color: 0xa9d8f0,
        /** 地面标识发光色。 */
        emissive: 0x5cb6df,
        /** 地面标识发光强度。 */
        emissiveIntensity: 1.2,
        /** 指令确认高光色。 */
        highlight: 0xeaf7ff,
      },
    },
    spectator: {
      /** 导播模式切换快捷键。 */
      toggleModeKey: 'KeyV',
      /** 切换到上一位观战目标快捷键。 */
      previousTargetKey: 'BracketLeft',
      /** 切换到下一位观战目标快捷键。 */
      nextTargetKey: 'BracketRight',
      /** 回到本地玩家快捷键。 */
      focusMeKey: 'KeyF',
    },
  },

  render: {
    /**
     * 渲染质量档位。
     * - 'low'：低端设备友好，关闭阴影/Bloom/雪花，DPR 限制为 1。
     * - 'medium'：平衡档，512 阴影贴图，DPR [1, 1.5]。
     * - 'high'：高画质，1024 阴影贴图，完整特效。
     * - 'ultra'：极高画质，2048 阴影贴图，DPR [1, 2]。
     */
    qualityPreset: 'medium' as 'low' | 'medium' | 'high' | 'ultra',
    /** Canvas DPR 范围。 */
    dpr: [1, 1.5] as [number, number],
    /** 是否启用阴影。 */
    enableShadows: true,
    /** 阴影贴图分辨率。 */
    shadowMapSize: 1024,
    /** 是否启用 Bloom。 */
    enableBloom: true,
    /** Bloom 强度。 */
    bloomIntensity: 0.28,
    /** Bloom 触发阈值。 */
    bloomThreshold: 0.9,
    /** Bloom 平滑系数。 */
    bloomSmoothing: 0.35,
    /** 是否启用雪花效果。 */
    enableSnow: true,
    /** 雪花粒子数量。 */
    snowCount: 1000,
    /** 全局曝光值。 */
    toneMappingExposure: 1,
    /** 英雄模型默认标准化高度。 */
    heroTargetHeight: 2.6,
    /** 是否显示性能监控面板（FPS / CPU / GPU / draw calls / 三角形等）。 */
    showPerfMonitor: false,
  },

  hud: {
    visibility: {
      /** 是否显示顶部左右两侧计分板。 */
      showScoreboard: true,
      /** 是否显示左下角英雄信息条。当前默认关闭，等待后续 UI 重构。 */
      showChampionInfoBar: false,
      /** 是否显示右下角小地图。当前默认关闭，等待后续 UI 重构。 */
      showMiniMap: false,
    },
    overhead: {
      /** 头顶 HUD 纹理宽度。 */
      textureWidth: 420,
      /** 头顶 HUD 纹理高度。 */
      textureHeight: 164,
      /** 自己名字字号。 */
      nameFontSize: 30,
      /** 其他角色名字字号。 */
      secondaryNameFontSize: 28,
      /** 血量数字字号。 */
      hpValueFontSize: 20,
      /** 蓝量数字字号。 */
      mpValueFontSize: 15,
      /** 等级数字字号。 */
      levelFontSize: 20,
      /** 血条分段数量。 */
      hpSegments: 24,
      /** 血条 sprite 的 Y 轴挂点。 */
      hpSpritePositionY: 5.0,
      /** 血条 sprite 的缩放尺寸。 */
      hpSpriteScale: [5.4, 2.26, 1] as [number, number, number],
      /** 表情 sprite 的 Y 轴挂点。 */
      emoteSpritePositionY: 8.0,
      /** 表情 sprite 的缩放尺寸。 */
      emoteSpriteScale: [1.5, 1.5, 1] as [number, number, number],
    },
    scoreboard: {
      /** 计分板距离顶部的偏移像素。 */
      topOffsetPx: 48,
      /** 计分板距离左右边缘的偏移像素。 */
      sideOffsetPx: 8,
      /** 队内成员卡片之间的垂直间距像素。 */
      rowGapPx: 4,
      /** 计分板等级数字字号。 */
      levelFontSize: 10,
      /** 计分板等级区域最小宽度像素。 */
      levelMinWidthPx: 18,
    },
  },

  emotes: {
    /** 可选表情定义列表。支持直接增删改以实现自定义表情。 */
    definitions: [
      {
        /** 表情唯一标识。 */
        id: 'poro',
        /** 表情使用的 emoji 字符。 */
        emoji: '🐾',
        /** UI 中显示的中文名称。 */
        label: '魄罗',
        /** 表情主色。 */
        color: '#d8f3ff',
        /** 表情强调色。 */
        accent: '#79d9ff',
      },
      {
        id: 'laugh',
        emoji: '😄',
        label: '大笑',
        color: '#ffe19a',
        accent: '#ffb348',
      },
      {
        id: 'cry',
        emoji: '😭',
        label: '哭泣',
        color: '#b8d9ff',
        accent: '#6aa7ff',
      },
      {
        id: 'angry',
        emoji: '😠',
        label: '愤怒',
        color: '#ffb2a8',
        accent: '#ff6a57',
      },
      {
        id: 'nice',
        emoji: '👍',
        label: 'Nice',
        color: '#b8ffd6',
        accent: '#4de191',
      },
      {
        id: 'love',
        emoji: '❤️',
        label: '爱心',
        color: '#ffc3db',
        accent: '#ff6ba3',
      },
      {
        id: 'surprised',
        emoji: '😲',
        label: '惊讶',
        color: '#f8edb6',
        accent: '#e7c84f',
      },
      {
        id: 'tease',
        emoji: '😜',
        label: '调皮',
        color: '#d9c8ff',
        accent: '#a56eff',
      },
    ] as EmoteDefinition[],
    /** 角色头顶表情持续显示时长。 */
    worldDisplayDurationMs: 1800,
    wheel: {
      /** 表情轮盘整体直径（含语音外圈）。 */
      size: 520,
      /** 表情轮盘外环半径。 */
      outerRadius: 170,
      /** 表情轮盘内环半径。 */
      innerRadius: 58,
      /** 命中检测在外环之外的额外容差。 */
      selectionOverflow: 36,
      /** 单个扇区表情图标容器尺寸。 */
      itemSize: 64,
      /** 扇区中表情 emoji 字号。 */
      emojiFontSize: 35,
      /** 扇区中表情名称字号。 */
      labelFontSize: 11,
      /** 轮盘中心标题字号。 */
      centerTitleFontSize: 11,
      /** 轮盘中心表情字号。 */
      centerEmojiFontSize: 30,
      /** 轮盘中心说明字号。 */
      centerHintFontSize: 12,
      /** 语音外圈半径。 */
      voiceRingOuterRadius: 230,
      /** 语音外圈单项容器尺寸。 */
      voiceRingItemSize: 56,
      /** 语音外圈 emoji 字号。 */
      voiceRingEmojiFontSize: 28,
      /** 语音外圈标签字号。 */
      voiceRingLabelFontSize: 16,
      /** 语音外圈选中溢出容差。 */
      voiceRingSelectionOverflow: 40,
    },
    announcement: {
      /** 是否显示表情发送侧栏轮播提示。 */
      enabled: true,
      /** 轮播栏出现在屏幕哪一侧。 */
      side: 'right' as 'left' | 'right',
      /** 轮播栏距离屏幕对应侧边缘的偏移像素。 */
      horizontalOffsetPx: 16,
      /** 轮播栏距离顶部的偏移像素。 */
      topOffsetPx: 80,
      /** 同时可见的最大提示条数。 */
      visibleCount: 4,
      /** 轮播队列最多保留的提示条数。 */
      maxQueue: 8,
      /** 单条提示的显示停留时长（毫秒），超时后开始淡出。 */
      itemDisplayDurationMs: 3000,
      /** 新条目滑入动画时长（毫秒）。 */
      enterAnimationMs: 300,
      /** 过期条目淡出动画时长（毫秒）。 */
      exitAnimationMs: 400,
      /** 条目之间的垂直间距像素。 */
      itemGapPx: 6,
      /** 提示条左右内边距。 */
      paddingX: 12,
      /** 提示条上下内边距。 */
      paddingY: 6,
      /** 提示文案字号。 */
      fontSize: 13,
      /** 提示中 emoji 字号。 */
      emojiFontSize: 18,
    },
  },

  environment: {
    bridge: {
      /** 桥体主体厚度。 */
      bodyHeight: 0.7,
      /** 桥体在桥宽基础上的额外外扩宽度。 */
      bodyExtraWidth: 0.42,
      /** 桥体支撑在桥宽基础上的额外外扩宽度。 */
      supportExtraWidth: 0.16,
      /** 上层护栏距离桥边的外扩距离。 */
      railingOffset: 0.62,
      /** 下层护栏距离桥边的外扩距离。 */
      lowerRailingOffset: 0.5,
      /** 桥面主平面高度。 */
      topSurfaceY: 0.024,
      /** 桥面冰层装饰高度。 */
      iceOverlayY: 0.086,
      /** 桥侧描边高度。 */
      edgeLineY: 0.134,
      /** 桥中央主高亮高度。 */
      centerLineY: 0.172,
      /** 桥中央扩散高亮高度。 */
      centerGlowY: 0.118,
      /** 中央遗迹底盘高度。 */
      ruinsBaseY: 0.028,
      /** 中央遗迹光环高度。 */
      ruinsRingY: 0.082,
      /** 桥体支撑距离桥两端的内缩距离。 */
      supportInsetX: 50,
      /** 桥体支撑沿 X 轴的间隔。 */
      supportSpacing: 20,
      /** 围栏立柱距离桥两端的内缩距离。 */
      railingPostInsetX: 32,
      /** 围栏立柱沿 X 轴的间隔。 */
      railingPostSpacing: 6,
      /** 围栏横梁距离桥两端的内缩距离。 */
      railingBeamInsetX: 30,
      /** 两端装饰柱距离桥两端的内缩距离。 */
      pillarInsetX: 30,
    },
    /** 中央遗迹（桥面正中心的悬浮冰晶区域）。 */
    ruins: {
      /** 中央遗迹模型路径。为 undefined 时显示程序化八面体冰晶 fallback。 */
      modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/other/npc_worldscup.glb' as string | undefined,
      /** 中央遗迹模型目标高度。 */
      targetHeight: 3.0,
      /** 中央遗迹模型绕 Y 轴旋转角度（弧度）。 */
      rotationY: 0,
      /** 中央遗迹待机动画片段名。 */
      idleClip: 'Idle' as string | undefined,
    },
    bushes: {
      left: {
        /** 左侧草丛在桥长度方向上的中心 X 坐标。 */
        x: -40,
        /** 左侧草丛距离桥墙的内缩距离。 */
        wallInset: 2,
        /** 左侧草丛尺寸。 */
        size: [8, 2.8, 3.5] as [number, number, number],
        /** 左侧草丛模型路径。 */
        modelPath: undefined as string | undefined,
        /** 左侧草丛模型目标高度。 */
        targetHeight: 2.6,
        /** 左侧草丛模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        animations: {
          /** 左侧草丛模型待机动画片段名。 */
          idleClip: undefined as string | undefined,
        },
      },
      center: {
        /** 中部草丛在桥长度方向上的中心 X 坐标。 */
        x: 0,
        /** 中部草丛距离桥墙的内缩距离。 */
        wallInset: 2,
        /** 中部草丛尺寸。 */
        size: [10, 3, 4] as [number, number, number],
        /** 中部草丛模型路径。 */
        modelPath: undefined as string | undefined,
        /** 中部草丛模型目标高度。 */
        targetHeight: 2.8,
        /** 中部草丛模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        animations: {
          /** 中部草丛模型待机动画片段名。 */
          idleClip: undefined as string | undefined,
        },
      },
      right: {
        /** 右侧草丛在桥长度方向上的中心 X 坐标。 */
        x: 40,
        /** 右侧草丛距离桥墙的内缩距离。 */
        wallInset: 2,
        /** 右侧草丛尺寸。 */
        size: [8, 2.8, 3.5] as [number, number, number],
        /** 右侧草丛模型路径。 */
        modelPath: undefined as string | undefined,
        /** 右侧草丛模型目标高度。 */
        targetHeight: 2.6,
        /** 右侧草丛模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        animations: {
          /** 右侧草丛模型待机动画片段名。 */
          idleClip: undefined as string | undefined,
        },
      },
    },
    /** 实例化草地配置（InstancedMesh 草片效果）。 */
    grass: {
      /** 草片 GLTF 模型路径。 */
      modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/other/grass.glb',
      /** 每个草丛区域的草片实例数量。 */
      count: 700,
      /** 草片最小随机缩放。 */
      scaleMin: 0.25,
      /** 草片最大随机缩放。 */
      scaleMax: 0.60,
      /** 草片高度缩放倍率（仅影响 Y 轴，控制草的高矮）。 */
      heightScale: 2.0,
      /** 风摆动强度（shader 中的振幅系数）。 */
      swayIntensity: 0.1,
    },
    towers: {
      /** 蓝队外塔模型路径。 */
      blueOuterModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/blue_tower.glb' as string | undefined,
      /** 蓝队内塔模型路径。 */
      blueInnerModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/blue_tower.glb' as string | undefined,
      /** 蓝队门牙塔模型路径。 */
      blueNexusGuardModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/blue_tower.glb' as string | undefined,
      /** 红队外塔模型路径。 */
      redOuterModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/red_tower.glb' as string | undefined,
      /** 红队内塔模型路径。 */
      redInnerModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/red_tower.glb' as string | undefined,
      /** 红队门牙塔模型路径。 */
      redNexusGuardModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/red_tower.glb' as string | undefined,
      /** 蓝队塔模型绕 Y 轴旋转角度（弧度）。 */
      blueRotationY: Math.PI / 2,
      /** 红队塔模型绕 Y 轴旋转角度（弧度）。 */
      redRotationY: -Math.PI / 2,
      /** 外塔模型目标高度。 */
      outerTargetHeight: 7.6,
      /** 外塔模型尺寸倍率。 */
      outerModelScale: 2.5,
      /** 外塔模型落地偏移。 */
      outerGroundOffsetY: -8.3,
      /** 外塔待机动画片段名。 */
      outerIdleClip: 'Idle1_Base' as string | undefined,
      /** 外塔小破动画片段名（血量 33%~66%）。 */
      outerDamagedClip: 'State2' as string | undefined,
      /** 外塔大破动画片段名（血量 1%~33%）。 */
      outerCriticalClip: 'State3' as string | undefined,
      /** 外塔死亡/销毁动画片段名。 */
      outerDeathClip: 'Destroyed' as string | undefined,
      /** 内塔模型目标高度。 */
      innerTargetHeight: 7.6,
      /** 内塔模型尺寸倍率。 */
      innerModelScale: 2.5,
      /** 内塔模型落地偏移。 */
      innerGroundOffsetY: -8.3,
      /** 内塔待机动画片段名。 */
      innerIdleClip: 'Idle1_Base' as string | undefined,
      /** 内塔小破动画片段名（血量 33%~66%）。 */
      innerDamagedClip: 'State2' as string | undefined,
      /** 内塔大破动画片段名（血量 1%~33%）。 */
      innerCriticalClip: 'State3' as string | undefined,
      /** 内塔死亡/销毁动画片段名。 */
      innerDeathClip: 'Destroyed' as string | undefined,
      /** 门牙塔模型目标高度。 */
      nexusGuardTargetHeight: 7.6,
      /** 门牙塔模型尺寸倍率。 */
      nexusGuardModelScale: 2.5,
      /** 门牙塔模型落地偏移。 */
      nexusGuardGroundOffsetY: -8.3,
      /** 门牙塔待机动画片段名。 */
      nexusGuardIdleClip: 'Destroyed' as string | undefined,
      /** 门牙塔小破动画片段名（血量 33%~66%）。 */
      nexusGuardDamagedClip: 'State2' as string | undefined,
      /** 门牙塔大破动画片段名（血量 1%~33%）。 */
      nexusGuardCriticalClip: 'State3' as string | undefined,
      /** 门牙塔死亡/销毁动画片段名。 */
      nexusGuardDeathClip: 'Destroyed' as string | undefined,
      /** 外塔生命值。 */
      outerMaxHp: 3000,
      /** 内塔生命值。 */
      innerMaxHp: 4000,
      /** 门牙塔生命值。 */
      nexusGuardMaxHp: 3500,
      /** 小破血量阈值（血量百分比 <= 此值进入小破状态）。 */
      damagedThreshold: 0.66,
      /** 大破血量阈值（血量百分比 <= 此值进入大破状态）。 */
      criticalThreshold: 0.33,
    },
    nexus: {
      /** 蓝队水晶模型路径。 */
      blueModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/blue_main_nexus.glb' as string | undefined,
      /** 红队水晶模型路径。 */
      redModelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/red_main_nexus.glb' as string | undefined,
      /** 水晶枢纽模型目标高度。 */
      targetHeight: 8.5,
      /** 水晶枢纽模型尺寸倍率。 */
      modelScale: 2.5,
      /** 水晶枢纽模型落地偏移。 */
      groundOffsetY: -15,
      /** 蓝队水晶模型绕 Y 轴旋转角度（弧度）。 */
      blueRotationY: 0,
      /** 红队水晶模型绕 Y 轴旋转角度（弧度）。 */
      redRotationY: Math.PI,
      /** 水晶枢纽待机动画片段名。 */
      idleClip: 'Idle1_Base' as string | undefined,
    },
    inhibitor: {
      /** 小水晶最大生命值。 */
      maxHp: 2500,
      blue: {
        /** 蓝方小水晶模型路径。 */
        modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/blue_small_nexus.glb' as string | undefined,
        /** 蓝方小水晶模型目标高度。 */
        targetHeight: 5.0,
        /** 蓝方小水晶模型尺寸倍率。 */
        modelScale: 3.2,
        /** 蓝方小水晶模型落地偏移。 */
        groundOffsetY: -10.1,
        /** 蓝方小水晶模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        /** 蓝方小水晶待机动画片段名。 */
        idleClip: 'Idle_Normal1' as string | undefined,
      },
      red: {
        /** 红方小水晶模型路径。 */
        modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/towers/red_smaill_nexus.glb' as string | undefined,
        /** 红方小水晶模型目标高度。 */
        targetHeight: 5.0,
        /** 红方小水晶模型尺寸倍率。 */
        modelScale: 3.2,
        /** 红方小水晶模型落地偏移。 */
        groundOffsetY: -10.1,
        /** 红方小水晶模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: Math.PI,
        /** 红方小水晶待机动画片段名。 */
        idleClip: 'Idle_Normal1' as string | undefined,
      },
    },
    relic: {
      /** 补血道具模型路径。 */
      modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/other/plant_honeyfruit.glb' as string | undefined,
      /** 生命遗迹模型目标高度。 */
      targetHeight: 3.2,
      /** 生命遗迹模型绕 Y 轴旋转角度（弧度）。 */
      rotationY: 0,
      /** 补血道具待机动画片段名。 */
      idleClip: undefined as string | undefined,
      /** 补血道具悬浮高度。 */
      floatHeight: 0.5,
      /** 补血道具上下浮动振幅。 */
      bobAmplitude: 0.3,
      /** 补血道具上下浮动速度。 */
      bobSpeed: 2,
      /** 补血道具底部光环外半径。 */
      ringOuterRadius: 1.2,
      /** 补血道具底部光环内半径。 */
      ringInnerRadius: 0.8,
    },
    fountain: {
      blue: {
        /** 蓝队泉水中心位置。 */
        position: [-130, 0, 0] as [number, number, number],
        /** 蓝队泉水地面半径。 */
        radius: 0,
        /** 蓝队泉水模型路径。 */
        modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/heroes/ahri/tft17_god_ahri.glb' as string | undefined,
        /** 蓝队泉水模型目标高度。 */
        targetHeight: 5.8,
        /** 蓝队泉水模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        /** 蓝队泉水待机动画片段名。 */
        idleClip: 'Idle1' as string | undefined,
      },
      red: {
        /** 红队泉水中心位置。 */
        position: [130, 0, 0] as [number, number, number],
        /** 红队泉水地面半径。 */
        radius: 0,
        /** 红队泉水模型路径。 */
        modelPath: 'https://cdn.xiaojingge.com/3d-battle/models/heroes/ahri/ahri_(tft_set_11).glb' as string | undefined,
        /** 红队泉水模型目标高度。 */
        targetHeight: 5.8,
        /** 红队泉水模型绕 Y 轴旋转角度（弧度）。 */
        rotationY: 0,
        /** 红队泉水待机动画片段名。 */
        idleClip: 'Celebration' as string | undefined,
      },
    },
  },

  /**
   * 英雄资源与对局阵容配置。
   *
   * 字段说明：
   * - `lineup`：对局阵容实例表。每一项都明确声明 `team`、`heroId`、`playerName`，并允许双方重复使用同一英雄。
   * - `skin`：阵容实例级皮肤名。填写后会优先按 `/models/heroes/${heroId}/${skin}.glb` 解析该实例模型路径。
   * - `isControlled`：标记本地玩家默认控制的唯一实例；若配置缺失或重复，运行时会做安全回退。
   * - `assets`：英雄资源配置表，键为 heroId。
   * - `modelPath`：当前直接启用的模型路径，可写本地静态资源路径，也可写任意远程 URL。
   * - `animations`：该英雄的动作片段、状态别名与播放行为覆盖配置；不填写时沿用默认模板。
   * - `voices`：英雄语音配置，支持普攻、Q/W/E/R、回城和静止待机语音。
   * - `modelScale`：模型相对统一英雄基准高度的尺寸倍率。`1` 为默认观感，大于 1 更大，小于 1 更小。
   * - `groundOffsetY`：模型完成归一化后的额外落地偏移量。负值下压模型，正值上抬模型。
   * - `overhead`：头顶血条与表情挂点的覆盖配置。
   */
  heroes: {
    /**
     * 当前对局阵容实例表。
     *
     * 约束说明：
     * - 阵容允许蓝红双方重复使用同一 `heroId`。
     * - 每个实例都必须显式声明所属队伍与玩家展示名。
     * - 若同一英雄需要在不同实例上使用不同皮肤，请直接在该实例上填写 `skin`。
     * - `isControlled` 建议全表只设置一个，用于唯一定位本地玩家控制角色。
     */
    lineup: MULTIPLAYER_TEST_LINEUP as HeroLineupConfig[],
    /** 英雄资源配置表，键为 heroId，值为当前启用模型、动画、语音、尺寸与挂点配置。 */
    assets: {
      /** 布隆默认资源配置。 */
      braum: createHeroAsset('braum', '布隆', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('braum', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.33,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.02,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 4.15, emoteSpritePositionY: 5.15 },
      }),
      /** 诺手默认资源配置。 */
      darius: createHeroAsset('darius', '诺克萨斯之手', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('darius', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/darius/诺克萨斯之手.glb'),
        /** 英雄动作与状态映射覆盖配置。 */
        animations: {
          stateAliases: {
            idle: ['Idle2'],
            standby: ['Joke'],
          },
          stateClips: {
            /** 待机动作片段名。 */
            idle: 'Idle2',
            /** 长期静止待机动作片段名。 */
            standby: 'Joke',
          },
          actionClips: {
            /** 基础普攻动作片段名。 */
            basicAttack: 'Attack1',
            /** Q 技能动作片段名。 */
            q: 'Spell1',
            /** W 技能动作片段名。 */
            w: 'Spell2',
            /** E 技能动作片段名。 */
            e: 'Spell3',
            /** R 技能动作片段名。 */
            r: 'Spell4',
            /** 回城动作片段名。 */
            recall: 'Recall',
          },
        },
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.84,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -1.53,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 4.12, emoteSpritePositionY: 5.12 },
      }),
      /** 亚索默认资源配置。 */
      yasuo: createHeroAsset('yasuo', '疾风剑豪', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('yasuo', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/疾风剑豪.glb'),
        /** 英雄动作与状态映射覆盖配置。 */
        animations: {
          stateAliases: {
            idle: ['Yasuo_Idle2'],
            standby: ['Joke'],
          },
          stateClips: {
            /** 待机动作片段名。 */
            idle: 'Yasuo_Idle2',
            /** 长期静止待机动作片段名。 */
            standby: 'Joke',
            /** 移动状态首选片段。 */
            run: 'Run2'
          },
          actionClips: {
            /** 基础普攻动作片段名。 */
            basicAttack: 'Attack1',
            /** Q 技能动作片段名。 */
            q: 'Spell1A',
            /** W 技能动作片段名。 */
            w: 'Spell2_0',
            /** E 技能动作片段名。 */
            e: 'Spell3',
            /** R 技能动作片段名。 */
            r: 'Spell4',
            /** 回城动作片段名。 */
            recall: 'Recall',
          },
          actionPlaybackRates: {
            /** 基础普攻默认原速播放。 */
            basicAttack: 1,
            /** Q 技能默认原速播放。 */
            q: 1,
            /** W 技能默认原速播放。 */
            w: 1,
            /** E 技能默认原速播放。 */
            e: 1,
            /** R 技能默认原速播放。 */
            r: 1,
            /** 回城默认原速播放。 */
            recall: 1,
          },
          actionDurationsMs: {
            /** 基础普攻持续时长。 */
            basicAttack: 450,
            /** Q 技能持续时长。 */
            q: 1000,
            /** W 技能持续时长。 */
            w: 520,
            /** E 技能持续时长。 */
            e: 420,
            /** R 技能持续时长。 */
            r: 1200,
            /** 回城持续时长。 */
            recall: 1200,
          },
          actionMovementLocks: {
            /** 基础普攻期间锁定移动。 */
            basicAttack: true,
            /** Q 技能期间锁定移动。 */
            q: true,
            /** W 技能期间锁定移动。 */
            w: true,
            /** E 技能期间锁定移动。 */
            e: true,
            /** R 技能期间锁定移动。 */
            r: true,
            /** 回城期间锁定移动。 */
            recall: true,
          }
        },
        /** 亚索专属语音配置。路径为占位，后续替换为真实语音文件。 */
        voices: {
          /** 基础普攻语音列表。 */
          basicAttack: [
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/basic-attack-1.wav',
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/basic-attack-2.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/basic-attack-3.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/basic-attack-4.wav'
          ],
          /** Q 技能（斩钢闪）语音列表。 */
          q: [
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/q-1.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/q-2.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/q-3.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/q-4.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/q-5.wav',
          ],
          /** W 技能（风之障壁）语音列表。 */
          w: [
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/w-1.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/w-2.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/w-3.wav',
          ],
          /** E 技能（踏前斩）语音列表。 */
          e: [
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/e-1.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/e-2.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/e-3.wav', 
            'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/e-4.wav',
          ],
          /** R 技能（狂风绝息斩）语音列表。 */
          r: [
            'r-1.wav', 
            'r-2.wav', 
            'r-3.wav',
          ],
          /** 回城语音列表。 */
          recall: ['recall-1.wav'],
          /** 英雄语音播放音量，范围 0-1。 */
          volume: 0.8,
          /** T轮盘自定义语音列表，用于表情轮盘外圈的英雄专属语音。 */
          customWheel: [
            { id: 'taunt', label: '嘲讽', emoji: '😏', voiceUrls: ['https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/taunt-1.wav', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/taunt-2.wav'], voiceVolume: 0.85 },
            { id: 'joke', label: '玩笑', emoji: '🤣', voiceUrls: ['https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/joke-1.wav', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/joke-2.wav', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/joke-3.wav',], voiceVolume: 0.85 },
            { id: 'provocation‌', label: '挑衅', emoji: '💃', voiceUrls: ['https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/provocation‌-1.wav', 'https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/provocation‌-2.wav',], voiceVolume: 0.85 },
            { id: 'laugh', label: '笑', emoji: '🎉', voiceUrls: ['https://cdn.xiaojingge.com/3d-battle/models/heroes/yasuo/voices/laugh.wav',], voiceVolume: 0.85 },
          ] as HeroWheelVoice[],
        },
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.50,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.05,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 6.0, emoteSpritePositionY: 9.00 },
      }),
      /** 蔚默认资源配置。 */
      vi: createHeroAsset('vi', '蔚-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('vi', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.31,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.04,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 4.02, emoteSpritePositionY: 5.02 },
      }),
      /** 拉克丝默认资源配置。 */
      lux: createHeroAsset('lux', '拉克丝-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('lux', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.33,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.03,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 3.98, emoteSpritePositionY: 4.98 },
      }),
      /** 安妮默认资源配置。 */
      annie: createHeroAsset('annie', '安妮-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('annie', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.31,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.02,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 3.82, emoteSpritePositionY: 4.78 },
      }),
      /** 艾希默认资源配置。 */
      ashe: createHeroAsset('ashe', '艾希-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('ashe', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.33,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.03,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 3.98, emoteSpritePositionY: 4.98 },
      }),
      /** 烬默认资源配置。 */
      jhin: createHeroAsset('jhin', '烬-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('jhin', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.31,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.03,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 4.04, emoteSpritePositionY: 5.04 },
      }),
      /** 索拉卡默认资源配置。 */
      soraka: createHeroAsset('soraka', '索拉卡-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('soraka', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.3,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.03,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 3.96, emoteSpritePositionY: 4.96 },
      }),
      /** 璐璐默认资源配置。 */
      lulu: createHeroAsset('lulu', '璐璐-经典', {
        /** 当前启用的模型路径。 */
        modelPath: createHeroModelUrl('lulu', 'classic.glb'),
        /** 模型相对统一英雄基准高度的尺寸倍率。 */
        modelScale: 1.36,
        /** 模型归一化后的额外落地偏移量。 */
        groundOffsetY: -0.02,
        /** 英雄头顶 HUD 挂点覆盖配置。 */
        overhead: { hpSpritePositionY: 3.78, emoteSpritePositionY: 4.7 },
      }),
    } as Record<string, HeroAssetConfig>,
  },

  multiplayer: {
    /** 是否启用联机模式。关闭后页面不会自动连接 Socket。 */
    enabled: true,
    /** Socket 服务端地址。开发环境默认连本机 3001 端口。 */
    socketServerUrl: 'http://localhost:8131',
    /** 默认联机房间 ID。当前 demo 固定为单房间。 */
    roomId: MULTIPLAYER_RUNTIME_CONFIG.roomId,
    /** 单房间最多允许自动分配的玩家人数。 */
    maxPlayers: MULTIPLAYER_RUNTIME_CONFIG.maxPlayers,
    /** 服务端权威状态推进帧率。 */
    simulationTickRate: MULTIPLAYER_RUNTIME_CONFIG.simulationTickRate,
    /** 服务端向客户端广播快照的频率。 */
    snapshotRate: MULTIPLAYER_RUNTIME_CONFIG.snapshotRate,
    /** 客户端渲染层对网络状态做平滑跟随时使用的延迟窗口，单位毫秒。 */
    renderDelayMs: MULTIPLAYER_RUNTIME_CONFIG.renderDelayMs,
    /** 客户端位置平滑强度，数值越大越快追上服务端权威位置。 */
    positionSmoothing: MULTIPLAYER_RUNTIME_CONFIG.positionSmoothing,
    /** 客户端朝向平滑强度，数值越大越快追上服务端权威朝向。 */
    rotationSmoothing: MULTIPLAYER_RUNTIME_CONFIG.rotationSmoothing,
    /** 允许在客户端暂存的快照数量上限，用于诊断显示与后续扩展。 */
    maxBufferedSnapshots: MULTIPLAYER_RUNTIME_CONFIG.maxBufferedSnapshots,
    /** 是否显示联机诊断面板。 */
    showDiagnosticsPanel: MULTIPLAYER_RUNTIME_CONFIG.showDiagnosticsPanel,
    /** 是否在诊断面板中显示帧率。 */
    showFps: MULTIPLAYER_RUNTIME_CONFIG.showFps,
    /** 客户端断线后 HUD 提示文案。 */
    disconnectMessage: MULTIPLAYER_RUNTIME_CONFIG.disconnectMessage,
  },

  debug: {
    worldCoordinates: {
      /** 是否默认显示世界坐标调试标签。 */
      enabled: false,
      /** 显示/隐藏世界坐标的快捷键。 */
      toggleKey: 'KeyG',
      /** 是否显示英雄标签。 */
      showChampions: true,
      /** 是否显示建筑标签。 */
      showStructures: true,
      /** 坐标保留的小数位。 */
      precision: 2,
      /** 标签相对对象的默认抬升高度。 */
      offsetY: 5.6,
      /** 标签字体大小，单位 px。 */
      fontSize: 28,
      /** 标签字体族。 */
      fontFamily: '黑体',
      /** drei Html 的 distanceFactor，数值越小标签越大。 */
      distanceFactor: 12,
    },
    animationHotkeys: {
      /** A 键触发的动作槽位。 */
      KeyA: 'basicAttack',
      /** Q 键触发的动作槽位。 */
      KeyQ: 'q',
      /** W 键触发的动作槽位。 */
      KeyW: 'w',
      /** E 键触发的动作槽位。 */
      KeyE: 'e',
      /** R 键触发的动作槽位。 */
      KeyR: 'r',
      /** B 键触发的动作槽位。 */
      KeyB: 'recall',
    } as Record<string, HeroActionSlot>,
    spectator: {
      /** 是否默认展示导播调试面板。 */
      showPanel: true,
    },
    /** 调试用自由三维视角配置，用于检查模型贴地等问题；与玩家镜头锁定、导播模式独立。 */
    freeCamera: {
      /** 是否默认启用调试自由视角。 */
      enabled: false,
      /** 切换调试自由三维视角的快捷键。 */
      toggleKey: 'KeyO',
    },
  },
} as const;
