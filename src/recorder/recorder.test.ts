import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from './recorder';
import { RecordedAction } from './actions';

const click = (sel: string): RecordedAction => ({ type: 'click', selector: sel, label: sel, ts: 1 });

test('actions are buffered only while recording', () => {
  const r = new Recorder();
  r.add(click('#a')); // ignored — not recording
  assert.equal(r.count(), 0);
  r.start();
  r.add(click('#b'));
  r.add(click('#c'));
  assert.equal(r.count(), 2);
  r.stop();
  r.add(click('#d')); // ignored — paused
  assert.equal(r.count(), 2);
});

test('clear wipes the buffer', () => {
  const r = new Recorder();
  r.start();
  r.add(click('#a'));
  assert.equal(r.count(), 1);
  r.clear();
  assert.equal(r.count(), 0);
  assert.deepEqual(r.actions(), []);
});

test('onChange notifies on state transitions', () => {
  const r = new Recorder();
  const states: Array<{ recording: boolean; count: number }> = [];
  r.onChange((s) => states.push(s));
  r.start();
  r.add(click('#a'));
  r.stop();
  assert.deepEqual(states.at(0), { recording: true, count: 0 });
  assert.deepEqual(states.at(1), { recording: true, count: 1 });
  assert.deepEqual(states.at(-1), { recording: false, count: 1 });
});

test('actions() returns a copy (no external mutation)', () => {
  const r = new Recorder();
  r.start();
  r.add(click('#a'));
  const copy = r.actions();
  copy.push(click('#x'));
  assert.equal(r.count(), 1);
});
