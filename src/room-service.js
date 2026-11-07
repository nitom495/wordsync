import {
  doc, getDoc, runTransaction, serverTimestamp,
} from 'firebase/firestore';
import { consensus, createRoomCode, normalizeWord, wordError, remainingSeconds } from './game.js';

export const roomRef = (db, code) => doc(db, 'rooms', code);
export const wordRef = (db, code, room, uid) =>
  doc(db, 'rooms', code, 'games', String(room.game), 'rounds', String(room.round), 'submissions', uid);

function requireRoom(snapshot) {
  if (!snapshot.exists()) throw new Error('房间不存在，请检查房间码');
  return snapshot.data();
}

export async function createRoom(db, uid, rawName, generate = createRoomCode) {
  const name = String(rawName ?? '').trim();
  if (!name || Array.from(name).length > 12) throw new Error('昵称需为 1–12 个字');
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generate();
    const ref = roomRef(db, code);
    const created = await runTransaction(db, async tx => {
      if ((await tx.get(ref)).exists()) return false;
      tx.set(ref, {
        hostUid: uid, phase: 'lobby', memberIds: [uid], names: { [uid]: name },
        game: 0, round: 0, submitted: [], revealSeconds: 15,
        revealedAt: null, createdAt: serverTimestamp(), action: 'create',
      });
      return true;
    });
    if (created) return code;
  }
  throw new Error('房间码暂时不可用，请重试');
}

export async function joinRoom(db, uid, rawName, code) {
  const name = String(rawName ?? '').trim();
  if (!name || Array.from(name).length > 12) throw new Error('昵称需为 1–12 个字');
  await runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (room.memberIds.includes(uid)) return;
    if (room.phase !== 'lobby') throw new Error('游戏已经开始，暂时不能加入');
    if (room.memberIds.length >= 5) throw new Error('房间已满，最多 5 人');
    tx.update(ref, {
      action: 'join',
      memberIds: [...room.memberIds, uid],
      names: { ...room.names, [uid]: name },
    });
  });
}

export async function setDuration(db, uid, code, seconds) {
  if (![15, 30, 45].includes(seconds)) throw new Error('请选择 15、30 或 45 秒');
  await runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (room.hostUid !== uid || room.phase !== 'lobby') throw new Error('只有等待室的房主可以设置时间');
    tx.update(ref, { action: 'duration', revealSeconds: seconds });
  });
}

export async function startGame(db, uid, code) {
  await runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (room.hostUid !== uid) throw new Error('只有房主可以开始游戏');
    if (!['lobby', 'finished'].includes(room.phase)) throw new Error('本局仍在进行');
    if (room.memberIds.length < 2) throw new Error('至少需要 2 人才能开始');
    tx.update(ref, {
      action: 'start', phase: 'input', game: room.game + 1, round: 1,
      submitted: [], revealedAt: null,
    });
  });
}

export async function submitWord(db, uid, code, rawWord) {
  const error = wordError(rawWord);
  if (error) throw new Error(error);
  const word = normalizeWord(rawWord);
  await runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (!room.memberIds.includes(uid)) throw new Error('你已不在这个房间');
    if (room.phase !== 'input') throw new Error('当前不在提交阶段');
    if (room.submitted.includes(uid)) throw new Error('本轮已经提交');
    const submission = wordRef(db, code, room, uid);
    if ((await tx.get(submission)).exists()) throw new Error('本轮已经提交');
    tx.set(submission, { uid, word, game: room.game, round: room.round });
    tx.update(ref, { action: 'submit', submitted: [...room.submitted, uid] });
  });
}

export async function revealIfReady(db, uid, code) {
  return runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (!room.memberIds.includes(uid) || room.phase !== 'input') return false;
    if (room.memberIds.some(id => !room.submitted.includes(id))) return false;
    tx.update(ref, { action: 'reveal', phase: 'reveal', revealedAt: serverTimestamp() });
    return true;
  });
}

async function readRound(tx, db, code, room) {
  const snapshots = await Promise.all(room.memberIds.map(uid => tx.get(wordRef(db, code, room, uid))));
  if (snapshots.some(snap => !snap.exists())) return null;
  return consensus(snapshots.map(snap => snap.data().word));
}

export async function finishIfMatched(db, uid, code) {
  return runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (!room.memberIds.includes(uid) || room.phase !== 'reveal') return false;
    const result = await readRound(tx, db, code, room);
    if (!result?.matched) return false;
    tx.update(ref, { action: 'finish', phase: 'finished' });
    return true;
  });
}

export async function advanceRoundIfReady(db, uid, code) {
  return runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (!room.memberIds.includes(uid) || room.phase !== 'reveal' || !room.revealedAt) return false;
    if (remainingSeconds(room.revealedAt.toMillis(), room.revealSeconds) > 0) return false;
    const result = await readRound(tx, db, code, room);
    if (!result || result.matched) return false;
    tx.update(ref, {
      action: 'next', phase: 'input', round: room.round + 1,
      submitted: [], revealedAt: null,
    });
    return true;
  });
}

export async function kickPlayer(db, uid, code, targetUid) {
  await runTransaction(db, async tx => {
    const ref = roomRef(db, code);
    const room = requireRoom(await tx.get(ref));
    if (room.hostUid !== uid || room.phase !== 'input') throw new Error('仅房主能在提交阶段移除玩家');
    if (targetUid === uid || !room.memberIds.includes(targetUid)) throw new Error('无法移除这位玩家');
    if (room.submitted.includes(targetUid)) throw new Error('不能移除已提交的玩家');
    const memberIds = room.memberIds.filter(id => id !== targetUid);
    const names = { ...room.names };
    delete names[targetUid];
    if (memberIds.length < 2) {
      tx.update(ref, { action: 'cancel', phase: 'lobby', memberIds, names, round: 0, submitted: [] });
    } else {
      tx.update(ref, { action: 'kick', memberIds, names });
    }
  });
}

export async function getRoom(db, code) {
  return requireRoom(await getDoc(roomRef(db, code)));
}
