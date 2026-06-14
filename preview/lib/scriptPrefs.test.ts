import {describe, it, expect} from 'vitest';
import {EMPTY_PREFS, getField, setField, diffOverride} from '@/lib/scriptPrefs';

describe('scriptPrefs dotted path get/set', () => {
  it('reads and writes nested fields immutably', () => {
    const next = setField(EMPTY_PREFS, 'style.wording', 'simple-direct');
    expect(getField(next, 'style.wording')).toBe('simple-direct');
    expect(getField(EMPTY_PREFS, 'style.wording')).toBe(''); // original untouched
  });

  it('reads and writes top-level fields', () => {
    const next = setField(EMPTY_PREFS, 'tone', 'energetic');
    expect(getField(next, 'tone')).toBe('energetic');
  });
});

describe('diffOverride', () => {
  it('is empty when nothing changed (byte-identical prompt)', () => {
    const global = setField(EMPTY_PREFS, 'tone', 'professional');
    expect(diffOverride(global, global)).toEqual({});
  });

  it('captures only the changed top-level field', () => {
    const global = setField(EMPTY_PREFS, 'tone', 'professional');
    const edited = setField(global, 'tone', 'energetic');
    expect(diffOverride(global, edited)).toEqual({tone: 'energetic'});
  });

  it('captures a changed nested field without dragging unchanged siblings', () => {
    let global = setField(EMPTY_PREFS, 'style.wording', 'simple-direct');
    global = setField(global, 'style.sentence_length', 'short-punchy');
    const edited = setField(global, 'style.wording', 'technical');
    expect(diffOverride(global, edited)).toEqual({style: {wording: 'technical'}});
  });

  it('captures a use_questions tri-state flip', () => {
    const edited = {...EMPTY_PREFS, style: {...EMPTY_PREFS.style, use_questions: false as boolean | null}};
    expect(diffOverride(EMPTY_PREFS, edited)).toEqual({style: {use_questions: false}});
  });

  it('captures script_types and interests array changes', () => {
    const edited = {
      ...EMPTY_PREFS,
      script_types: ['listicle'],
      audience: {...EMPTY_PREFS.audience, interests: ['productivity']},
    };
    expect(diffOverride(EMPTY_PREFS, edited)).toEqual({
      script_types: ['listicle'],
      audience: {interests: ['productivity']},
    });
  });
});
