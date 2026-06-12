import {staticFile} from 'remotion';
import type {Manifest, ResolvedAssets} from '../../templates/sdk';

/**
 * The ONE asset access path (§4.4/§15.1): maps a manifest's declared asset
 * relPaths ("assets/<sub>") to staticFile URLs under the installed namespace
 * template-assets/<id>/<sub>. Templates index this map with the declared
 * string verbatim; hand-built staticFile() strings are forbidden by the
 * authoring standard so installs stay relocatable. No declared assets → {}
 * (identical to the previous literal `assets={{}}` — regression R1).
 */
export function resolveAssets(manifest: Manifest): ResolvedAssets {
  if (!manifest.assets || manifest.assets.length === 0) return {};
  const out: ResolvedAssets = {};
  for (const rel of manifest.assets) {
    out[rel] = staticFile(`template-assets/${manifest.id}/${rel.replace(/^assets\//, '')}`);
  }
  return out;
}
