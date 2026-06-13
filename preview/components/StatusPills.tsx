// Studio v3 M6 — StatusPills: MEDIA + TEMPLATE per collapsed scene row (F3a, ruling 15).
//
// Two pill slots per scene row:
//   MEDIA    — derived from provenance (footage scenes) OR backgroundProvenance (hero scenes).
//   TEMPLATE — only when scene.templateOverride !== null → shows the override template id.
//
// MEDIA derivation (precedence: pinned > uploaded > re-queried > auto):
//   Footage scenes (needsFootage === true):
//     provenance.source 'pick'     → "pinned"      indigo
//     provenance.source 'uploaded' → "uploaded"    green
//     provenance.source 're_query' → "re-queried"  amber
//     provenance.source 'auto'     → "auto"        dim
//   Hero scenes (needsFootage === false):
//     backgroundProvenance null               → "gradient"    dim  (floor — no clip)
//     backgroundProvenance.source 'pinned'    → "bg pinned"   indigo
//     backgroundProvenance.source 'uploaded'  → "uploaded"    green
//     backgroundProvenance.source 're_query'  → "re-queried"  amber
//     backgroundProvenance.source 'bg auto'   → "bg auto"     dim
//     backgroundProvenance.source 'auto'      → "bg auto"     dim  (alias)
//
// TEMPLATE pill: scene.templateOverride !== null → label = override.value, tone indigo.
//
// This file exports the two pure derivation functions (testable without a browser)
// and the React component.
//
// Badge tones map onto the existing BadgeTone type from components/ui.tsx:
//   indigo  → 'purple'  (the existing purple tone is #a78bfa, close enough for v3 indigo)
//   green   → 'green'
//   amber   → 'amber'
//   gray/dim → 'dim'
//
// NOTE: 'indigo' is purposely mapped to the existing 'purple' BadgeTone rather than
// adding a new tone — ruling 15 says "tones reuse the existing Badge BadgeTone map".

import type {SceneState} from '@/lib/studio';
import type {BadgeTone} from '@/components/ui';
import {Badge} from '@/components/ui';

// ─── derivation functions (pure — no React) ───────────────────────────────────

export type PillResult = {label: string; tone: BadgeTone};

/**
 * Derives the MEDIA pill for a scene row.
 * Returns null only when there is no meaningful media signal (shouldn't happen
 * in normal flow, but guard against undefined provenance on footage scenes).
 */
export function deriveMediaPill(scene: SceneState): PillResult | null {
  if (scene.needsFootage) {
    // Footage scene — use provenance
    const prov = scene.provenance;
    if (!prov) return null;
    switch (prov.source) {
      case 'pick':
        return {label: 'pinned', tone: 'purple'};
      case 'uploaded':
        return {label: 'uploaded', tone: 'green'};
      case 're_query':
        return {label: 're-queried', tone: 'amber'};
      case 'auto':
      default:
        return {label: 'auto', tone: 'dim'};
    }
  } else {
    // Hero scene — use backgroundProvenance
    const bgProv = scene.backgroundProvenance;
    if (!bgProv) {
      // null → gradient (floor)
      return {label: 'gradient', tone: 'dim'};
    }
    switch (bgProv.source) {
      case 'pinned':
        return {label: 'bg pinned', tone: 'purple'};
      case 'uploaded':
        return {label: 'uploaded', tone: 'green'};
      case 're_query':
        return {label: 're-queried', tone: 'amber'};
      case 'bg auto':
      case 'auto':
      default:
        return {label: 'bg auto', tone: 'dim'};
    }
  }
}

/**
 * Derives the TEMPLATE pill for a scene row.
 * Only present when scene.templateOverride !== null.
 */
export function deriveTemplatePill(scene: SceneState): PillResult | null {
  if (scene.templateOverride === null || scene.templateOverride === undefined) {
    return null;
  }
  return {label: scene.templateOverride.value, tone: 'purple'};
}

// ─── component ────────────────────────────────────────────────────────────────

/**
 * Renders MEDIA + TEMPLATE pills for a collapsed scene row.
 * Pure presentational — receives a SceneState and renders up to two Badge pills.
 */
export function StatusPills({scene}: {scene: SceneState}) {
  const mediaPill = deriveMediaPill(scene);
  const templatePill = deriveTemplatePill(scene);

  if (!mediaPill && !templatePill) return null;

  return (
    <span className="flex items-center gap-1.5">
      {mediaPill && (
        <Badge tone={mediaPill.tone}>{mediaPill.label}</Badge>
      )}
      {templatePill && (
        <Badge tone={templatePill.tone}>{templatePill.label}</Badge>
      )}
    </span>
  );
}
