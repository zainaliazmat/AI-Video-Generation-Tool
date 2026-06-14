// Channel-voice script preferences — client-side field model + helpers.
// Mirrors backend/pipeline/script_prefs.py EMPTY. Drives the shared StylePrefsForm
// used by both the global settings page and the per-video override panel.

import type {ScriptPrefs} from '@/lib/studio';

export const EMPTY_PREFS: ScriptPrefs = {
  tone: '',
  audience: {age_range: '', knowledge_level: '', interests: []},
  style: {wording: '', sentence_length: '', use_questions: null, use_statistics: ''},
  hook_style: '',
  personality: '',
  use_humor: '',
  storytelling: '',
  cta_preference: '',
  channel_niche: '',
  script_types: [],
};

type Opt = {value: string; label: string};

// Single-select chip groups keyed by a dotted path into ScriptPrefs.
export const SELECT_FIELDS: {path: string; label: string; options: Opt[]}[] = [
  {path: 'tone', label: 'Tone', options: [
    {value: 'casual-friendly', label: 'Casual & friendly'},
    {value: 'professional', label: 'Professional'},
    {value: 'energetic', label: 'Energetic'},
    {value: 'educational', label: 'Educational'},
    {value: 'inspirational', label: 'Inspirational'},
    {value: 'humorous', label: 'Humorous'},
  ]},
  {path: 'hook_style', label: 'Hook style', options: [
    {value: 'question', label: 'Question'},
    {value: 'bold-statement', label: 'Bold statement'},
    {value: 'problem', label: 'Problem'},
    {value: 'promise', label: 'Promise'},
    {value: 'shock', label: 'Shock'},
    {value: 'story', label: 'Story'},
  ]},
  {path: 'personality', label: 'Personality', options: [
    {value: 'energetic', label: 'Energetic'},
    {value: 'calm', label: 'Calm'},
    {value: 'witty', label: 'Witty'},
    {value: 'serious', label: 'Serious'},
    {value: 'passionate', label: 'Passionate'},
    {value: 'relatable', label: 'Relatable'},
  ]},
  {path: 'style.wording', label: 'Wording', options: [
    {value: 'simple-direct', label: 'Simple & direct'},
    {value: 'descriptive', label: 'Descriptive'},
    {value: 'technical', label: 'Technical'},
    {value: 'storytelling', label: 'Storytelling'},
  ]},
  {path: 'style.sentence_length', label: 'Sentence length', options: [
    {value: 'short-punchy', label: 'Short & punchy'},
    {value: 'medium', label: 'Medium'},
    {value: 'long-flowing', label: 'Long & flowing'},
  ]},
  {path: 'style.use_statistics', label: 'Statistics', options: [
    {value: 'heavy', label: 'Heavy'},
    {value: 'moderate', label: 'Moderate'},
    {value: 'light', label: 'Light'},
    {value: 'none', label: 'None'},
  ]},
  {path: 'use_humor', label: 'Humor', options: [
    {value: 'yes', label: 'Yes'},
    {value: 'sparingly', label: 'Sparingly'},
    {value: 'no', label: 'No'},
  ]},
  {path: 'storytelling', label: 'Storytelling', options: [
    {value: 'heavy', label: 'Heavy'},
    {value: 'moderate', label: 'Moderate'},
    {value: 'light', label: 'Light'},
  ]},
  {path: 'cta_preference', label: 'Call to action', options: [
    {value: 'direct', label: 'Direct'},
    {value: 'soft', label: 'Soft'},
    {value: 'minimal', label: 'Minimal'},
  ]},
  {path: 'audience.age_range', label: 'Audience age', options: [
    {value: 'teens', label: 'Teens'},
    {value: '20s-30s', label: '20s–30s'},
    {value: '35-50', label: '35–50'},
    {value: '50+', label: '50+'},
  ]},
  {path: 'audience.knowledge_level', label: 'Knowledge level', options: [
    {value: 'beginners', label: 'Beginners'},
    {value: 'intermediate', label: 'Intermediate'},
    {value: 'expert', label: 'Expert'},
  ]},
];

export const SCRIPT_TYPE_OPTIONS: Opt[] = [
  {value: 'educational', label: 'Educational'},
  {value: 'listicle', label: 'Listicle'},
  {value: 'story', label: 'Story'},
  {value: 'review', label: 'Review'},
  {value: 'commentary', label: 'Commentary'},
  {value: 'how-to', label: 'How-to'},
  {value: 'explainer', label: 'Explainer'},
];

// ── dotted-path get/set on a ScriptPrefs object (immutable set) ──────────────

export function getField(prefs: ScriptPrefs, path: string): string {
  const [a, b] = path.split('.');
  const top = (prefs as Record<string, unknown>)[a];
  if (b) return String((top as Record<string, unknown>)?.[b] ?? '');
  return String(top ?? '');
}

export function setField(prefs: ScriptPrefs, path: string, value: string): ScriptPrefs {
  const [a, b] = path.split('.');
  if (b) {
    const top = {...((prefs as Record<string, unknown>)[a] as Record<string, unknown>)};
    top[b] = value;
    return {...prefs, [a]: top};
  }
  return {...prefs, [a]: value};
}

// Compute the per-video override: only fields that DIFFER from the global default.
// An empty object means "no override" → byte-identical prompt.
export function diffOverride(global: ScriptPrefs, edited: ScriptPrefs): Partial<ScriptPrefs> {
  const out: Record<string, unknown> = {};
  for (const f of SELECT_FIELDS) {
    if (getField(edited, f.path) !== getField(global, f.path)) {
      const [a, b] = f.path.split('.');
      if (b) {
        const grp = (out[a] as Record<string, unknown>) ?? {};
        grp[b] = getField(edited, f.path);
        out[a] = grp;
      } else {
        out[a] = getField(edited, f.path);
      }
    }
  }
  if (edited.style.use_questions !== global.style.use_questions) {
    out.style = {...(out.style as Record<string, unknown> ?? {}), use_questions: edited.style.use_questions};
  }
  if (edited.channel_niche !== global.channel_niche) out.channel_niche = edited.channel_niche;
  if (edited.audience.interests.join(',') !== global.audience.interests.join(',')) {
    out.audience = {...(out.audience as Record<string, unknown> ?? {}), interests: edited.audience.interests};
  }
  if (edited.script_types.join(',') !== global.script_types.join(',')) {
    out.script_types = edited.script_types;
  }
  return out as Partial<ScriptPrefs>;
}
