import './styles.css';
import { collection, onSnapshot } from 'firebase/firestore';
import { connectFirebase, hasFirebaseConfig } from './firebase-client.js';
import { consensus, remainingSeconds } from './game.js';
import {
  roomRef, createRoom, joinRoom, setDuration, startGame, submitWord,
  revealIfReady, finishIfMatched, advanceRoundIfReady, kickPlayer, getRoom,
} from './room-service.js';

const app = document.querySelector('#app');
const initialCode = new URL(location.href).searchParams.get('room')?.toUpperCase() ?? '';
const state = {
  db: null, uid: null, code: null, room: null, words: [],
  name: localStorage.getItem('wordsync:name') ?? '',
  joinCode: initialCode, draft: '', inputKey: '',
  error: '', toast: '', busy: false, connecting: true,
};
let unsubscribeRoom = null;
let unsubscribeWords = null;
let wordsKey = '';
let lastWordsRoundKey = '';
let wordsRetryCount = 0;
let transitionKey = '';
let transitionBusy = false;
let lastAdvanceAttempt = 0;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const countText = count => String(count).padStart(2, '0');
const codePattern = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function displayError(error) {
  if (error?.code === 'permission-denied') return '操作未被房间规则允许，请刷新页面后重试';
  if (error?.code === 'unavailable') return '网络连接中断，请检查网络后重试';
  return error?.message || '操作失败，请重试';
}

function inviteUrl(code) {
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  return url.toString();
}

function setRoomInUrl(code) {
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

function showToast(message) {
  state.toast = message;
  render();
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = '';
      render();
    }
  }, 3200);
}

async function action(task) {
  if (state.busy || !state.db || !state.uid) return;
  state.busy = true;
  state.error = '';
  render();
  try {
    await task();
  } catch (error) {
    state.error = displayError(error);
  } finally {
    state.busy = false;
    render();
  }
}

function enterRoom(code) {
  state.code = code;
  state.room = null;
  state.words = [];
  wordsKey = '';
  lastWordsRoundKey = '';
  transitionKey = '';
  unsubscribeRoom?.();
  unsubscribeWords?.();
  unsubscribeWords = null;
  setRoomInUrl(code);
  unsubscribeRoom = onSnapshot(roomRef(state.db, code), snapshot => {
    if (!snapshot.exists()) {
      state.error = '房间不存在，请检查房间码';
      leaveView();
      return;
    }
    const room = snapshot.data();
    if (!room.memberIds.includes(state.uid)) {
      state.error = '你已不在这个房间';
      leaveView();
      return;
    }
    const newInputKey = `${room.game}:${room.round}`;
    if (room.phase === 'input' && state.inputKey !== newInputKey) {
      state.draft = '';
      state.inputKey = newInputKey;
    }
    state.room = room;
    syncWords();
    render();
    settle();
  }, error => {
    state.error = displayError(error);
    render();
  });
  render();
}

function leaveView() {
  unsubscribeRoom?.();
  unsubscribeWords?.();
  unsubscribeRoom = null;
  unsubscribeWords = null;
  wordsKey = '';
  state.code = null;
  state.room = null;
  state.words = [];
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  render();
}

function syncWords() {
  const room = state.room;
  const key = room && ['reveal', 'finished'].includes(room.phase)
    ? `${room.game}:${room.round}` : '';
  if (key === wordsKey) return;
  unsubscribeWords?.();
  unsubscribeWords = null;
  if (key !== lastWordsRoundKey) {
    wordsRetryCount = 0;
    lastWordsRoundKey = key;
  }
  wordsKey = key;
  state.words = [];
  if (!key) return;
  unsubscribeWords = onSnapshot(collection(
    state.db, 'rooms', state.code, 'games', String(room.game),
    'rounds', String(room.round), 'submissions',
  ), snapshot => {
    state.words = snapshot.docs.map(item => item.data());
    render();
    settle();
  }, error => {
    if (wordsKey !== key) return;
    if (error?.code === 'permission-denied' && wordsRetryCount < 2) {
      wordsRetryCount += 1;
      setTimeout(() => {
        if (wordsKey !== key || !['reveal', 'finished'].includes(state.room?.phase)) return;
        wordsKey = '';
        syncWords();
      }, 900);
      return;
    }
    state.error = displayError(error);
    render();
  });
}

function roundResult() {
  const room = state.room;
  if (!room || state.words.length < room.memberIds.length) return null;
  const byUid = new Map(state.words.map(item => [item.uid, item.word]));
  if (room.memberIds.some(uid => !byUid.has(uid))) return null;
  return { byUid, ...consensus(room.memberIds.map(uid => byUid.get(uid))) };
}

async function transitionError(error, alreadyAdvanced) {
  if (error?.code === 'permission-denied') {
    try {
      if (alreadyAdvanced(await getRoom(state.db, state.code))) return;
    } catch { /* Report the original transition error below. */ }
  }
  state.error = displayError(error);
  render();
}

async function settle() {
  const room = state.room;
  if (!room || transitionBusy) return;
  const key = `${room.game}:${room.round}:${room.phase}`;
  if (transitionKey === key) return;
  const readyToReveal = room.phase === 'input' && room.memberIds.every(uid => room.submitted.includes(uid));
  const readyToFinish = room.phase === 'reveal' && roundResult()?.matched;
  if (!readyToReveal && !readyToFinish) return;
  const order = room.memberIds.indexOf(state.uid);
  if (order > 0) {
    transitionKey = key;
    await new Promise(resolve => setTimeout(resolve, order * 1200));
    const current = state.room;
    if (!current || `${current.game}:${current.round}:${current.phase}` !== key) return;
    transitionKey = '';
  }
  if (readyToReveal) {
    transitionKey = key;
    transitionBusy = true;
    try { await revealIfReady(state.db, state.uid, state.code); }
    catch (error) {
      transitionKey = '';
      await transitionError(error, current => current.phase === 'reveal' || current.phase === 'finished');
    }
    finally { transitionBusy = false; }
  } else if (readyToFinish) {
    transitionKey = key;
    transitionBusy = true;
    try { await finishIfMatched(state.db, state.uid, state.code); }
    catch (error) {
      transitionKey = '';
      await transitionError(error, current => current.phase === 'finished');
    }
    finally { transitionBusy = false; }
  }
}

function tick() {
  const room = state.room;
  if (!room || room.phase !== 'reveal' || !room.revealedAt) return;
  const left = remainingSeconds(room.revealedAt.toMillis(), room.revealSeconds);
  const countdown = app.querySelector('[data-countdown]');
  if (countdown) countdown.textContent = countText(left);
  const timer = app.querySelector('[data-timer]');
  if (timer) timer.style.setProperty('--progress', String(1 - left / room.revealSeconds));
  if (left === 0 && roundResult() && !roundResult().matched
      && Date.now() - lastAdvanceAttempt > 2500 && !transitionBusy) {
    lastAdvanceAttempt = Date.now();
    advanceRoundIfReady(state.db, state.uid, state.code).catch(error => {
      if (error?.code !== 'permission-denied') {
        state.error = displayError(error);
        render();
      }
    });
  }
}

function brand() {
  return `<header class="brand"><a href="./" aria-label="同频首页" data-action="home"><span class="brand-mark">✳</span><span>同频 <small>WORDSYNC</small></span></a><span class="brand-note">一场关于默契的小游戏</span></header>`;
}

function shell(content) {
  return `<div class="site-shell">${brand()}${state.error ? `<div class="alert" role="alert">${esc(state.error)}<button data-action="dismiss" aria-label="关闭提示">×</button></div>` : ''}
    ${content}
    ${state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ''}
    <footer class="footer"><span>同频 · WordSync</span><span>想到同一个词，就是我们的默契。</span></footer></div>`;
}

function home() {
  const disabled = state.connecting || !state.uid || state.busy ? 'disabled' : '';
  const setup = !hasFirebaseConfig()
    ? '<div class="setup-note">Firebase 尚未配置。请按 README 设置项目后，即可创建在线房间。</div>'
    : '';
  return shell(`<main class="home-layout">
    <section class="hero">
      <div class="eyebrow"><span class="dot"></span> 2–5 人在线文字游戏</div>
      <h1>想到同一个词，<br><em>就是我们的默契。</em></h1>
      <p class="hero-copy">从不同的词出发，看看你和朋友需要几轮，才能不约而同地想到一起。</p>
      <div class="hero-number"><span>01</span><span class="line"></span><span>轻轻一想，看看多同频</span></div>
    </section>
    <section class="entry-card" aria-label="开始游戏">
      <div class="card-top"><span>开始一场游戏</span><span>✳</span></div>
      ${setup}
      <label for="nickname">你的昵称</label>
      <input id="nickname" name="nickname" maxlength="12" autocomplete="nickname" placeholder="怎么称呼你？" value="${esc(state.name)}" />
      <form id="create-form"><button class="button primary" type="submit" ${disabled}>创建房间 <span>↗</span></button></form>
      <div class="divider"><span>或者加入朋友</span></div>
      <form id="join-form" class="join-form">
        <input id="room-code" name="room-code" maxlength="6" inputmode="text" autocapitalize="characters" placeholder="6 位房间码" value="${esc(state.joinCode)}" />
        <button class="button secondary" type="submit" ${disabled}>加入</button>
      </form>
      <p class="entry-hint">${state.connecting ? '正在连接游戏服务…' : '无需注册，输入昵称即可一起玩。'}</p>
    </section>
  </main>`);
}

function roomHeader(label) {
  return `<div class="room-heading"><div><div class="eyebrow"><span class="dot"></span> ${label}</div><h1>房间 <span>${esc(state.code)}</span></h1></div><button class="text-button" data-action="copy">复制邀请链接 ↗</button></div>`;
}

function playerCards(room, removable = false) {
  return `<div class="players">${room.memberIds.map((uid, index) => `
    <div class="player-card">
      <div class="player-avatar">${countText(index + 1)}</div>
      <div class="player-info"><strong>${esc(room.names[uid])}</strong><small>${uid === room.hostUid ? '房主' : uid === state.uid ? '你' : '玩家'}${room.phase === 'input' ? ` · ${room.submitted.includes(uid) ? '已提交' : '等待提交'}` : ''}</small></div>
      ${removable && room.hostUid === state.uid && uid !== state.uid && !room.submitted.includes(uid)
        ? `<button class="kick" data-action="kick" data-uid="${esc(uid)}" title="移除未提交玩家">移除</button>` : ''}
      ${room.phase === 'input' ? `<span class="status-dot ${room.submitted.includes(uid) ? 'ready' : ''}"></span>` : ''}
    </div>`).join('')}</div>`;
}

function lobby(room) {
  const isHost = room.hostUid === state.uid;
  return shell(`<main class="room-layout">${roomHeader('等待好友加入')}
    <div class="content-grid"><section class="panel">
      <div class="section-title"><span>01 / 玩家</span><span>${room.memberIds.length} / 5</span></div>
      ${playerCards(room)}
      <div class="invite-box"><span>分享房间码</span><strong>${esc(state.code)}</strong><button data-action="copy">复制链接 ↗</button></div>
    </section><section class="panel settings-panel">
      <div class="section-title"><span>02 / 游戏设置</span><span>每轮揭晓</span></div>
      <h2>留多少时间<br>看大家的词？</h2>
      <p>揭晓后会自动倒计时，进入下一轮。</p>
      <div class="duration-options" role="group" aria-label="揭晓时长">
        ${[15, 30, 45].map(sec => `<button data-action="duration" data-seconds="${sec}" class="${room.revealSeconds === sec ? 'selected' : ''}" ${!isHost || state.busy ? 'disabled' : ''}>${sec}<small>秒</small></button>`).join('')}
      </div>
      ${isHost ? `<button class="button primary start-button" data-action="start" ${room.memberIds.length < 2 || state.busy ? 'disabled' : ''}>开始游戏 <span>↗</span></button><p class="small-note">${room.memberIds.length < 2 ? '至少再邀请 1 位朋友。' : '大家准备好后，就可以开始。'}</p>`
      : '<div class="waiting-message"><span class="pulse"></span>等待房主开始游戏</div>'}
    </section></div>
  </main>`);
}

function inputStage(room) {
  const mine = room.submitted.includes(state.uid);
  return shell(`<main class="play-layout">
    <div class="round-top"><span class="eyebrow"><span class="dot"></span> 第 ${room.round} 轮</span><span>${room.submitted.length} / ${room.memberIds.length} 人已提交</span></div>
    <div class="play-hero"><span class="round-giant">${countText(room.round)}</span><h1>你现在想到<br><em>什么词？</em></h1><p>独立想一个词。提交后，其他人暂时看不到。</p></div>
    <div class="play-grid"><section class="panel input-panel">
      <div class="section-title"><span>你的答案</span><span>最多 20 个字</span></div>
      ${mine ? '<div class="submitted-state"><span>✓</span><strong>已提交，等待大家</strong><p>所有人完成后会同时揭晓。</p></div>'
      : `<form id="word-form"><input id="word-input" maxlength="20" autocomplete="off" placeholder="输入一个词…" value="${esc(state.draft)}" autofocus /><button class="button primary" type="submit" ${state.busy ? 'disabled' : ''}>确认提交 <span>↗</span></button></form>`}
      <p class="small-note">提交后本轮不能修改。试着和朋友想到一起。</p>
    </section><section class="panel"><div class="section-title"><span>本轮玩家</span><span>进度实时同步</span></div>${playerCards(room, true)}</section></div>
  </main>`);
}

function revealStage(room) {
  const result = roundResult();
  const finished = room.phase === 'finished' || result?.matched;
  return shell(`<main class="play-layout reveal-layout">
    <div class="round-top"><span class="eyebrow"><span class="dot"></span> 第 ${room.round} 轮 · 已揭晓</span><span>${finished ? '终于，同频了。' : '看看大家想到了什么'}</span></div>
    <div class="reveal-heading"><div><p class="overline">所有词语 · 同时揭晓</p><h1>${finished ? '我们想到了一起。' : '再靠近一点点。'}</h1><p>${finished ? `历经 ${room.round} 轮，大家都想到了「${esc(result?.leader ?? '')}」。` : '记住这一轮的词，下一轮继续向彼此靠拢。'}</p></div>
      ${finished ? `<div class="score-orb"><strong>${countText(room.round)}</strong><span>总轮数</span></div>`
      : `<div class="score-orb timer-orb" data-timer><strong data-countdown>${room.revealedAt ? countText(remainingSeconds(room.revealedAt.toMillis(), room.revealSeconds)) : '--'}</strong><span>秒后下一轮</span></div>`}
    </div>
    ${result ? `<div class="reveal-grid">${room.memberIds.map((uid, index) => `<div class="reveal-card"><div class="reveal-card-top"><span>${countText(index + 1)} / ${esc(room.names[uid])}</span><span>✳</span></div><strong>${esc(result.byUid.get(uid))}</strong></div>`).join('')}</div>
    <div class="consensus-panel"><div><span>本轮一致程度</span><strong>${result.count} / ${result.total} 人想到「${esc(result.leader)}」</strong></div><span class="percent">${result.percent}%</span><div class="meter"><span style="width:${result.percent}%"></span></div></div>`
    : '<div class="loading-words">正在同步大家的词语…</div>'}
    ${room.phase === 'finished' && room.hostUid === state.uid ? `<button class="button primary replay-button" data-action="replay" ${state.busy ? 'disabled' : ''}>再玩一局 <span>↗</span></button>` : ''}
    ${room.phase === 'finished' && room.hostUid !== state.uid ? '<p class="waiting-replay">等待房主发起新的一局…</p>' : ''}
  </main>`);
}

function render() {
  const room = state.room;
  app.innerHTML = !state.code || !room ? home()
    : room.phase === 'lobby' ? lobby(room)
      : room.phase === 'input' ? inputStage(room)
        : revealStage(room);
  tick();
}

app.addEventListener('input', event => {
  if (event.target.id === 'nickname') state.name = event.target.value;
  if (event.target.id === 'room-code') state.joinCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (event.target.id === 'word-input') state.draft = event.target.value;
});

app.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'create-form') action(async () => {
    const name = state.name.trim();
    const code = await createRoom(state.db, state.uid, name);
    localStorage.setItem('wordsync:name', name);
    enterRoom(code);
  });
  if (event.target.id === 'join-form') action(async () => {
    const name = state.name.trim();
    const code = state.joinCode.trim().toUpperCase();
    if (!codePattern.test(code)) throw new Error('请输入正确的 6 位房间码');
    await joinRoom(state.db, state.uid, name, code);
    localStorage.setItem('wordsync:name', name);
    enterRoom(code);
  });
  if (event.target.id === 'word-form') action(async () => {
    await submitWord(state.db, state.uid, state.code, state.draft);
    state.draft = '';
  });
});

app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const type = button.dataset.action;
  if (type === 'dismiss') { state.error = ''; render(); }
  if (type === 'home') { event.preventDefault(); leaveView(); }
  if (type === 'copy') action(async () => {
    const link = inviteUrl(state.code);
    try { await navigator.clipboard.writeText(link); showToast('邀请链接已复制'); }
    catch { window.prompt('复制这条邀请链接', link); }
  });
  if (type === 'duration') action(() => setDuration(state.db, state.uid, state.code, Number(button.dataset.seconds)));
  if (type === 'start' || type === 'replay') action(() => startGame(state.db, state.uid, state.code));
  if (type === 'kick') {
    const name = state.room?.names[button.dataset.uid];
    if (window.confirm(`移除「${name}」并让其他人继续吗？`)) {
      action(() => kickPlayer(state.db, state.uid, state.code, button.dataset.uid));
    }
  }
});

async function boot() {
  render();
  try {
    const { db, uid } = await connectFirebase();
    state.db = db;
    state.uid = uid;
    state.connecting = false;
    if (codePattern.test(initialCode) && state.name.trim()) {
      try {
        await joinRoom(db, uid, state.name, initialCode);
        enterRoom(initialCode);
      } catch (error) {
        state.error = displayError(error);
        render();
      }
    } else {
      render();
    }
  } catch (error) {
    state.connecting = false;
    state.error = displayError(error);
    render();
  }
}

setInterval(tick, 500);
boot();
