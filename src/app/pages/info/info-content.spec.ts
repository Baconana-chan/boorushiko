import { describe, expect, it } from 'vitest';
import { infoContent, type InfoPageId } from './info-content';

const PAGES: InfoPageId[] = ['about', 'help', 'dmca', 'tos'];

describe('info page content', () => {
  it('has a full EN and RU version of every page', () => {
    for (const page of PAGES) {
      const en = infoContent(page, 'en');
      const ru = infoContent(page, 'ru');
      expect(en.title.length).toBeGreaterThan(0);
      expect(ru.title.length).toBeGreaterThan(0);
      expect(en.sections.length).toBeGreaterThan(0);
      expect(en.sections.length).toBe(ru.sections.length);
    }
  });

  it('exposes the takedown contact only on the DMCA page', () => {
    expect(infoContent('dmca', 'en').contactEmail).toMatch(/@/);
    expect(infoContent('about', 'en').contactEmail).toBeUndefined();
    expect(infoContent('tos', 'ru').contactEmail).toBeUndefined();
  });
});
