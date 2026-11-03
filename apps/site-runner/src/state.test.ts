import { describe, expect, it } from 'vitest';
import { classifyOrphan, parseState, planAdoption, serializeState, type PidProbe, type TrackedEntry } from './state.js';

function entry(key: string, overrides: Partial<TrackedEntry> = {}): TrackedEntry {
  return {
    key,
    rowVersion: 1,
    kind: 'runtime',
    dir: `/w/sites/${key}`,
    pid: 1000,
    port: 5000,
    uid: 20001,
    gid: 19990,
    rssMb: 256,
    alive: true,
    ...overrides,
  };
}

describe('planAdoption', () => {
  it('adopts only entries whose pid is alive with matching cwd and uid', () => {
    const entries = [entry('good'), entry('dead'), entry('moved'), entry('reowned'), entry('unprobed')];
    const probes = new Map<string, PidProbe>([
      ['good', { alive: true, cwd: '/w/sites/good', uid: 20001 }],
      ['dead', { alive: false }],
      ['moved', { alive: true, cwd: '/w/sites/other', uid: 20001 }],
      ['reowned', { alive: true, cwd: '/w/sites/reowned', uid: 20002 }],
    ]);
    const { adopted, dropped } = planAdoption(entries, probes);
    expect(adopted.map((e) => e.key)).toEqual(['good']);
    expect(adopted[0]!.alive).toBe(true);
    expect(dropped.map((e) => e.key).sort()).toEqual(['dead', 'moved', 'reowned', 'unprobed']);
  });

  it('adopts nothing from an empty state', () => {
    expect(planAdoption([], new Map())).toEqual({ adopted: [], dropped: [] });
  });
});

describe('serializeState / parseState', () => {
  it('round-trips entries', () => {
    const entries = [entry('a'), entry('b', { alive: false, rowVersion: 7 })];
    expect(parseState(serializeState(entries))).toEqual(entries);
  });

  it('returns [] for corrupt input instead of throwing', () => {
    expect(parseState('not json')).toEqual([]);
    expect(parseState('{}')).toEqual([]);
    expect(parseState('{"entries":"x"}')).toEqual([]);
    expect(parseState('{"entries":[{"key":5}]}')).toEqual([]);
    expect(parseState('null')).toEqual([]);
  });

  it('keeps well-formed entries and drops malformed siblings', () => {
    const json = JSON.stringify({ version: 1, entries: [entry('ok'), { key: 'bad' }] });
    expect(parseState(json).map((e) => e.key)).toEqual(['ok']);
  });
});

describe('classifyOrphan', () => {
  const tracked = new Set(['/w/sites/known']);

  it('never touches a tracked tree', () => {
    expect(classifyOrphan('/w/sites/known', '/w', tracked)).toBe('tracked');
    expect(classifyOrphan('/w/demo-sessions', '/w', new Set(['/w/demo-sessions']))).toBe('tracked');
  });

  it('kills survivors of ephemeral demo and import trees', () => {
    expect(classifyOrphan('/w/demo-sessions/session-1', '/w', tracked)).toBe('kill');
    expect(classifyOrphan('/w/import-9/run-42', '/w', tracked)).toBe('kill');
    expect(classifyOrphan('/w/import-9/run-42/nested', '/w', tracked)).toBe('kill');
  });

  it('leaves untracked site trees and everything else alone', () => {
    expect(classifyOrphan('/w/sites/unknown', '/w', tracked)).toBe('leave');
    expect(classifyOrphan('/w/tmp/staging', '/w', tracked)).toBe('leave');
    expect(classifyOrphan('/elsewhere/proc', '/w', tracked)).toBe('leave');
  });
});
