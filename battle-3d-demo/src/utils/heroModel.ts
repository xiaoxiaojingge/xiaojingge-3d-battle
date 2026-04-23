import { getHeroAssetConfig } from '../config/heroConfig';
import { getAssetDirectory, resolveAssetUrl } from './assetUrl';

export function getHeroModelPath(
  heroId: string,
  options?: {
    skin?: string;
    overridePath?: string;
  },
): string {
  if (options?.overridePath) {
    return options.overridePath;
  }

  if (options?.skin) {
    const skinModelPath = `/models/heroes/${heroId}/${options.skin}.glb`;
    return resolveAssetUrl(skinModelPath) ?? skinModelPath;
  }

  return getHeroAssetConfig(heroId)?.modelPath
    || resolveAssetUrl(`/models/heroes/${heroId}/classic.glb`)
    || `/models/heroes/${heroId}/classic.glb`;
}

export function getHeroTextureBasePath(heroId: string, skin?: string): string {
  const modelPath = getHeroModelPath(heroId, { skin });
  return getHeroAssetConfig(heroId)?.textureBasePath
    || getAssetDirectory(modelPath)
    || resolveAssetUrl(`/models/heroes/${heroId}/`)
    || `/models/heroes/${heroId}/`;
}
