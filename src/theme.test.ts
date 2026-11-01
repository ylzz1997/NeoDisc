import { expect, test } from 'vitest';
import { defaults, isNight, resolveTheme } from './theme';
test('night schedule handles midnight and exact boundaries', () => {
  expect(isNight('19:00','19:00','07:00')).toBe(true);
  expect(isNight('23:59','19:00','07:00')).toBe(true);
  expect(isNight('06:59','19:00','07:00')).toBe(true);
  expect(isNight('07:00','19:00','07:00')).toBe(false);
  expect(isNight('12:00','19:00','07:00')).toBe(false);
  expect(isNight('12:00','09:00','17:00')).toBe(true);
  expect(isNight('12:00','07:00','07:00')).toBe(true);
});
test('manual theme is independent of system, automatic follows preference', () => {
  expect(resolveTheme(defaults,new Date(),false)).toBe('dark');
  expect(resolveTheme({...defaults,mode:'system'},new Date(),false)).toBe('light');
  expect(resolveTheme({...defaults,mode:'schedule'},new Date(2026,0,1,20),false)).toBe('dark');
});
