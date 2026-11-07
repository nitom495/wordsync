import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection } from 'firebase/firestore';
import { consensus } from '../src/game.js';
import {
  createRoom, joinRoom, startGame, submitWord, revealIfReady,
  finishIfMatched, advanceRoundIfReady, kickPlayer,
} from '../src/room-service.js';

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-wordsync',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});
after(async () => { await env?.cleanup(); });

test('two players complete a match, replay, and move past a mismatched round', async () => {
  await env.clearFirestore();
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const code = await createRoom(alice, 'alice', '小安', () => 'ABC234');
  assert.equal(code, 'ABC234');
  await joinRoom(bob, 'bob', '小波', code);
  await startGame(alice, 'alice', code);
  await submitWord(alice, 'alice', code, '  山  ');
  await submitWord(bob, 'bob', code, '山');
  await revealIfReady(alice, 'alice', code);
  await finishIfMatched(bob, 'bob', code);
  let snap = await getDoc(doc(alice, 'rooms', code));
  assert.equal(snap.data().phase, 'finished');
  await startGame(alice, 'alice', code);
  await submitWord(alice, 'alice', code, '山');
  await submitWord(bob, 'bob', code, '海');
  await revealIfReady(bob, 'bob', code);
  await env.withSecurityRulesDisabled(async context => {
    await context.firestore().doc(`rooms/${code}`).update({ revealedAt: new Date(Date.now() - 60_000) });
  });
  await advanceRoundIfReady(alice, 'alice', code);
  snap = await getDoc(doc(bob, 'rooms', code));
  assert.equal(snap.data().round, 2);
  assert.equal(snap.data().phase, 'input');
});

test('host can remove an unsubmitted player and cancel when one remains', async () => {
  await env.clearFirestore();
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const carol = env.authenticatedContext('carol').firestore();
  const code = await createRoom(alice, 'alice', '小安', () => 'XYZ789');
  await joinRoom(bob, 'bob', '小波', code);
  await joinRoom(carol, 'carol', '小可', code);
  await startGame(alice, 'alice', code);
  await kickPlayer(alice, 'alice', code, 'carol');
  await kickPlayer(alice, 'alice', code, 'bob');
  const snap = await getDoc(doc(alice, 'rooms', code));
  assert.equal(snap.data().phase, 'lobby');
  assert.deepEqual(snap.data().memberIds, ['alice']);
});

test('five players reveal together and a sixth cannot enter', async () => {
  await env.clearFirestore();
  const ids = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const dbs = Object.fromEntries(ids.map(id => [id, env.authenticatedContext(id).firestore()]));
  const code = await createRoom(dbs.alice, 'alice', '小安', () => 'QRS567');
  for (const id of ids.slice(1)) await joinRoom(dbs[id], id, id, code);
  await assert.rejects(
    joinRoom(env.authenticatedContext('frank').firestore(), 'frank', 'frank', code),
    /房间已满/,
  );
  await startGame(dbs.alice, 'alice', code);
  for (const [index, id] of ids.entries()) {
    await submitWord(dbs[id], id, code, index < 3 ? '山'.repeat(20) : '海');
  }
  await revealIfReady(dbs.erin, 'erin', code);
  const words = await getDocs(collection(dbs.bob, 'rooms', code, 'games', '1', 'rounds', '1', 'submissions'));
  assert.equal(words.size, 5);
  assert.equal(consensus(words.docs.map(item => item.data().word)).percent, 60);
});
