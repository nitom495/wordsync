import test, { before, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

let env;
const roomPath = 'rooms/ABC234';
const wordPath = `${roomPath}/games/1/rounds/1/submissions/alice`;

function room(overrides = {}) {
  return {
    hostUid: 'alice', phase: 'input', memberIds: ['alice', 'bob'],
    names: { alice: '小安', bob: '小波' }, game: 1, round: 1,
    submitted: [], revealSeconds: 15, revealedAt: null, action: 'create',
    ...overrides,
  };
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-wordsync',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async context => {
    await context.firestore().doc(path).set(data);
  });
}

test('only the author sees a word before reveal; members see it after reveal', async () => {
  await seed(roomPath, room());
  await seed(wordPath, { uid: 'alice', word: '山', game: 1, round: 1 });
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  const outsider = env.authenticatedContext('mallory').firestore();
  await assertSucceeds(alice.doc(wordPath).get());
  await assertFails(bob.doc(wordPath).get());
  await assertFails(outsider.doc(wordPath).get());
  await seed(roomPath, room({ phase: 'reveal', submitted: ['alice', 'bob'], revealedAt: new Date() }));
  await assertSucceeds(bob.doc(wordPath).get());
  await assertFails(outsider.doc(wordPath).get());
});

test('a sixth player cannot join a full lobby', async () => {
  const ids = ['alice', 'bob', 'carol', 'dave', 'erin'];
  await seed(roomPath, room({ phase: 'lobby', memberIds: ids, names: Object.fromEntries(ids.map(id => [id, id])) }));
  const frank = env.authenticatedContext('frank').firestore();
  await assertFails(frank.doc(roomPath).update({ action: 'join', memberIds: [...ids, 'frank'], 'names.frank': 'frank' }));
});

test('a player cannot overwrite a submitted word', async () => {
  await seed(roomPath, room({ submitted: ['alice'] }));
  await seed(wordPath, { uid: 'alice', word: '山', game: 1, round: 1 });
  const alice = env.authenticatedContext('alice').firestore();
  await assertFails(alice.doc(wordPath).set({ uid: 'alice', word: '海' }));
});

test('a member cannot start the next round before the reveal timer expires', async () => {
  await seed(roomPath, room({ phase: 'reveal', submitted: ['alice', 'bob'], revealedAt: new Date() }));
  const bob = env.authenticatedContext('bob').firestore();
  await assertFails(bob.doc(roomPath).update({ action: 'next', phase: 'input', round: 2, submitted: [], revealedAt: null }));
});

test('an anonymous user cannot read a room', async () => {
  await seed(roomPath, room());
  const stranger = env.unauthenticatedContext().firestore();
  await assertFails(stranger.doc(roomPath).get());
});

test('host creates a room and a second player joins the lobby', async () => {
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(alice.doc(roomPath).set(room({
    phase: 'lobby', game: 0, round: 0, memberIds: ['alice'],
    names: { alice: '小安' }, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  })));
  await assertSucceeds(bob.doc(roomPath).update({
    action: 'join', memberIds: ['alice', 'bob'], 'names.bob': '小波',
  }));
});

test('host starts, a player submits once, then everyone reveals', async () => {
  await seed(roomPath, room({ phase: 'lobby', game: 0, round: 0, createdAt: new Date() }));
  const alice = env.authenticatedContext('alice').firestore();
  const bob = env.authenticatedContext('bob').firestore();
  await assertSucceeds(alice.doc(roomPath).update({
    action: 'start', phase: 'input', game: 1, round: 1, submitted: [], revealedAt: null,
  }));
  const batch = alice.batch();
  batch.set(alice.doc(wordPath), { uid: 'alice', word: '山', game: 1, round: 1 });
  batch.update(alice.doc(roomPath), { action: 'submit', submitted: ['alice'] });
  await assertSucceeds(batch.commit());
  await seed(`${roomPath}/games/1/rounds/1/submissions/bob`, { uid: 'bob', word: '海', game: 1, round: 1 });
  await seed(roomPath, room({ submitted: ['alice', 'bob'] }));
  await assertSucceeds(bob.doc(roomPath).update({
    action: 'reveal', phase: 'reveal', revealedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }));
});

test('matching words finish and mismatched words advance after the deadline', async () => {
  const old = new Date(Date.now() - 60_000);
  await seed(roomPath, room({ phase: 'reveal', submitted: ['alice', 'bob'], revealedAt: old }));
  await seed(wordPath, { uid: 'alice', word: '山', game: 1, round: 1 });
  await seed(`${roomPath}/games/1/rounds/1/submissions/bob`, { uid: 'bob', word: '山', game: 1, round: 1 });
  const alice = env.authenticatedContext('alice').firestore();
  await assertSucceeds(alice.doc(roomPath).update({ action: 'finish', phase: 'finished' }));
  await seed(roomPath, room({ phase: 'reveal', submitted: ['alice', 'bob'], revealedAt: old }));
  await seed(`${roomPath}/games/1/rounds/1/submissions/bob`, { uid: 'bob', word: '海', game: 1, round: 1 });
  await assertSucceeds(alice.doc(roomPath).update({
    action: 'next', phase: 'input', round: 2, submitted: [], revealedAt: null,
  }));
});

test('host removes an unsubmitted third player', async () => {
  await seed(roomPath, room({
    memberIds: ['alice', 'bob', 'carol'],
    names: { alice: '小安', bob: '小波', carol: '小可' },
  }));
  const alice = env.authenticatedContext('alice').firestore();
  await assertSucceeds(alice.doc(roomPath).update({
    action: 'kick', memberIds: ['alice', 'bob'],
    names: { alice: '小安', bob: '小波' },
  }));
});

test('kick cannot replace a member or silently rename another member', async () => {
  await seed(roomPath, room({
    memberIds: ['alice', 'bob', 'carol'],
    names: { alice: '小安', bob: '小波', carol: '小可' },
  }));
  const alice = env.authenticatedContext('alice').firestore();
  await assertFails(alice.doc(roomPath).update({
    action: 'kick', memberIds: ['alice', 'mallory'],
    names: { alice: '小安', bob: '小波' },
  }));
  await assertFails(alice.doc(roomPath).update({
    action: 'kick', memberIds: ['alice', 'bob'],
    names: { alice: '改名', bob: '小波' },
  }));
});
