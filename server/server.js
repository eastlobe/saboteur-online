// server.js - 사보타지 Authoritative Game Server v2.0
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const db = require('./db.js');
const engine = require('./gameEngine.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

app.post('/api/register', async (req, res) => {
  const result = await db.registerUser(req.body.username, req.body.password, req.body.nickname);
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/api/login', async (req, res) => {
  const result = await db.loginUser(req.body.username, req.body.password);
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  const user = db.getUserByToken(token);
  if (!user) return res.status(401).json({ success: false });
  res.json({ success: true, user });
});

const rooms = {};

function getRoomPublicList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    hostId: r.hostId,
    hostName: r.hostName,
    playerCount: r.playerOrder.length,
    observerCount: Object.keys(r.observers || {}).length,
    mapCardCount: r.mapCardCount || 6,
    status: r.status
  }));
}

// 플레이어별 맞춤형 상태 (Fog of War & 점수 은닉 & 관전 뷰)
function getFilteredGameState(room, targetUserId) {
  const isGameEnd = room.status === 'GAME_END';
  const showRoles = room.status === 'ROUND_END' || isGameEnd || room.status === 'GOLD_DRAFT';

  // 옵션 B: 관전자도 비밀 정보는 보지 못하고 공개 정보만 투명하게 관전!
  const isTargetObserver = Boolean(room.observers && room.observers[targetUserId]);

  const sanitizedPlayers = room.playerOrder.map(uid => {
    const p = room.players[uid];
    const isMe = uid === targetUserId;

    const myGoldCards = p.goldCards || [];
    const myTotalGold = myGoldCards.reduce((acc, c) => acc + c.value, 0);

    return {
      userId: p.userId,
      nickname: p.nickname,
      isHost: room.hostId === uid,
      connected: p.connected,
      tools: p.tools,
      // 게임 종료 전까지는 금 카드 '장수'만 공개
      goldCardCount: myGoldCards.length,
      // 총 금덩이 개수는 본인과 최종 게임 종료 시에만 공개
      totalGold: (isMe || isGameEnd) ? myTotalGold : null,
      goldCards: (isMe || isGameEnd) ? myGoldCards : null,
      cardCount: p.hand ? p.hand.length : 0,
      role: (isMe || showRoles) ? p.role : 'HIDDEN',
      hand: isMe ? p.hand : null
    };
  });

  const observersList = Object.values(room.observers || {}).map(o => ({
    userId: o.userId,
    nickname: o.nickname
  }));

  return {
    roomId: room.id,
    roomName: room.name,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    maxRounds: room.maxRounds,
    turnIdx: room.turnIdx,
    currentTurnUid: room.playerOrder[room.turnIdx] || null,
    deckCount: room.deck ? room.deck.length : 0,
    discardCount: room.discardPile ? room.discardPile.length : 0,
    // 공식 룰 6번: 카드는 뒷면으로 버리므로 어떤 카드인지 절대 공개하지 않음!
    lastDiscardedText: room.lastDiscardedText || null,
    board: room.board,
    destinations: Object.values(room.destinations || {}).map(d => ({
      id: d.id,
      row: d.row,
      col: d.col,
      name: d.label,
      inspectedBy: d.inspectedBy || null,
      revealed: d.revealed,
      isGold: d.revealed ? d.isGold : null
    })),
    players: sanitizedPlayers,
    observers: observersList,
    isObserver: isTargetObserver,
    mapCardCount: room.mapCardCount || 6,
    lastAction: room.lastAction,
    roundResult: room.roundResult,
    goldDraft: room.goldDraft ? {
      currentUid: room.goldDraft.order[room.goldDraft.currentIdx],
      pool: room.goldDraft.pool,
      isMyPick: room.goldDraft.order[room.goldDraft.currentIdx] === targetUserId
    } : null
  };
}

function broadcastRoomState(room) {
  // 플레이어에게 전송
  room.playerOrder.forEach(uid => {
    const player = room.players[uid];
    if (player && player.socketId) {
      io.to(player.socketId).emit('game_state_update', getFilteredGameState(room, uid));
    }
  });
  // 관전자에게 전송
  Object.values(room.observers || {}).forEach(obs => {
    if (obs.socketId) {
      io.to(obs.socketId).emit('game_state_update', getFilteredGameState(room, obs.userId));
    }
  });
}

function startNewRound(room) {
  const pCount = room.playerOrder.length;
  const roleConfig = engine.ROLE_SETTINGS[pCount];
  if (!roleConfig) return false;

  const rolePool = [];
  for (let i = 0; i < roleConfig.miners; i++) rolePool.push('MINER');
  for (let i = 0; i < roleConfig.saboteurs; i++) rolePool.push('SABOTEUR');
  const shuffledRoles = engine.shuffle(rolePool);

  // 덱 생성 시 방장이 설정한 지도 카드 수 적용
  const deck = engine.shuffle(engine.createDeck(room.mapCardCount));
  const { board, destinations } = engine.createInitialBoard();

  room.board = board;
  room.destinations = destinations;
  room.deck = deck;
  room.discardPile = [];
  room.lastDiscardedText = null;
  room.goldDraft = null;

  const handSize = engine.HAND_SIZES[pCount] || 4;
  room.playerOrder.forEach((uid, idx) => {
    const player = room.players[uid];
    player.role = shuffledRoles[idx];
    player.tools = { pickaxe: true, lantern: true, cart: true };
    player.hand = [];
    for (let h = 0; h < handSize; h++) {
      if (room.deck.length > 0) player.hand.push(room.deck.pop());
    }
  });

  room.status = 'PLAYING';
  room.turnIdx = 0;
  room.roundResult = null;
  room.lastAction = { message: `${room.round}라운드가 시작되었습니다. ⛏️` };
  return true;
}

function advanceTurn(room) {
  const allEmpty = room.playerOrder.every(uid => room.players[uid].hand.length === 0);
  if (room.deck.length === 0 && allEmpty) {
    endRound(room, 'SABOTEURS', null, '덱과 모든 카드가 소진되어 광부들이 실패했습니다.');
    return;
  }
  room.turnIdx = (room.turnIdx + 1) % room.playerOrder.length;
}

function endRound(room, winningTeam, lastConnectorUid, reasonMsg) {
  const goldDeck = room.goldDeck || engine.createGoldDeck();
  room.goldDeck = goldDeck;

  Object.values(room.destinations).forEach(d => {
    d.revealed = true;
    room.board[d.row][d.col] = d.actualCard;
  });

  if (winningTeam === 'MINERS') {
    const miners = room.playerOrder.filter(uid => room.players[uid].role === 'MINER');
    const drawCount = miners.length;
    const drawnCards = [];
    for (let i = 0; i < drawCount; i++) {
      drawnCards.push(goldDeck.length > 0 ? goldDeck.pop() : { id: `gold_ex_${i}`, value: 1 });
    }

    let startIdx = room.playerOrder.indexOf(lastConnectorUid);
    if (startIdx === -1) startIdx = 0;

    const draftOrder = [];
    for (let i = 0; i < room.playerOrder.length; i++) {
      const idx = (startIdx - i + room.playerOrder.length) % room.playerOrder.length;
      const uid = room.playerOrder[idx];
      if (room.players[uid].role === 'MINER') {
        draftOrder.push(uid);
      }
    }

    room.status = 'GOLD_DRAFT';
    room.goldDraft = {
      pool: drawnCards,
      order: draftOrder,
      currentIdx: 0,
      reasonMsg: reasonMsg
    };

    room.lastAction = {
      message: `광부단 승리! 1등 광부(${room.players[lastConnectorUid]?.nickname})부터 금 카드를 가져갑니다.`
    };
  } else {
    const saboteurs = room.playerOrder.filter(uid => room.players[uid].role === 'SABOTEUR');
    const sCount = saboteurs.length;
    let nVal = 2;
    if (sCount === 1) nVal = 4;
    else if (sCount === 2 || sCount === 3) nVal = 3;

    saboteurs.forEach((uid, idx) => {
      const p = room.players[uid];
      p.goldCards.push({ id: `sab_gold_${idx}_${Date.now()}`, value: nVal });
    });

    finalizeRoundEnd(room, 'SABOTEURS', reasonMsg);
  }
}

function finalizeRoundEnd(room, winningTeam, reasonMsg) {
  room.status = 'ROUND_END';
  room.goldDraft = null;

  const isFinal = room.round >= room.maxRounds;
  if (isFinal) room.status = 'GAME_END';

  room.roundResult = {
    winningTeam,
    reason: reasonMsg,
    isFinalRound: isFinal
  };

  room.lastAction = {
    message: `${room.round}라운드 종료! ${winningTeam === 'MINERS' ? '광부단 승리 ⛏️' : '방해꾼 승리 💣'}`
  };
}

io.use((socket, next) => {
  const user = db.getUserByToken(socket.handshake.auth.token);
  if (!user) return next(new Error('인증 실패'));
  socket.userId = user.userId;
  socket.nickname = user.nickname;
  next();
});

io.on('connection', (socket) => {
  const { userId, nickname } = socket;

  // 재접속 자동 복구
  const userObj = db.getUserById(userId);
  if (userObj?.activeRoomId && rooms[userObj.activeRoomId]) {
    const room = rooms[userObj.activeRoomId];
    if (room.players[userId]) {
      room.players[userId].connected = true;
      room.players[userId].socketId = socket.id;
      socket.join(room.id);
      broadcastRoomState(room);
    } else if (room.observers && room.observers[userId]) {
      room.observers[userId].socketId = socket.id;
      socket.join(room.id);
      broadcastRoomState(room);
    }
  }

  socket.on('get_room_list', () => {
    socket.emit('room_list_update', getRoomPublicList());
  });

  // 방 생성 (지도 카드 개수 옵션 0~6장 지원)
  socket.on('create_room', ({ roomName, mapCardCount }, callback) => {
    const roomId = 'room_' + Math.random().toString(36).substring(2, 8);
    const validMapCount = Math.max(0, Math.min(6, Number(mapCardCount) !== undefined ? Number(mapCardCount) : 6));

    const room = {
      id: roomId,
      name: roomName?.trim() || `${nickname} 님의 광산`,
      hostId: userId,
      hostName: nickname,
      maxPlayers: 10,
      mapCardCount: validMapCount,
      status: 'WAITING',
      round: 1,
      maxRounds: 3,
      goldDeck: engine.createGoldDeck(),
      players: {
        [userId]: {
          userId,
          nickname,
          socketId: socket.id,
          connected: true,
          goldCards: [],
          tools: { pickaxe: true, lantern: true, cart: true },
          role: null,
          hand: []
        }
      },
      observers: {},
      playerOrder: [userId],
      turnIdx: 0,
      board: null,
      destinations: null,
      deck: null,
      discardPile: [],
      lastDiscardedText: null,
      goldDraft: null,
      lastAction: null,
      roundResult: null
    };

    rooms[roomId] = room;
    db.setUserActiveRoom(userId, roomId);
    socket.join(roomId);
    if (callback) callback({ success: true, roomId });
    io.emit('room_list_update', getRoomPublicList());
    broadcastRoomState(room);
  });

  // 방 설정 변경 (방장이 시작 전 지도 카드 개수 조절)
  socket.on('update_room_settings', ({ mapCardCount }, callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.hostId !== userId || room.status !== 'WAITING') return;

    room.mapCardCount = Math.max(0, Math.min(6, Number(mapCardCount)));
    if (callback) callback({ success: true, mapCardCount: room.mapCardCount });
    broadcastRoomState(room);
    io.emit('room_list_update', getRoomPublicList());
  });

  // 방 참가 (플레이어 vs 관전자 선택)
  socket.on('join_room', ({ roomId, roleType }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback && callback({ success: false, message: '방이 없습니다.' });

    const isObserver = roleType === 'OBSERVER';

    if (!isObserver && room.status !== 'WAITING' && !room.players[userId]) {
      return callback && callback({ success: false, message: '게임이 진행 중이어서 플레이어로 참가할 수 없습니다. 관전자로 입장해주세요.' });
    }

    if (!isObserver && !room.players[userId] && room.playerOrder.length >= 10) {
      return callback && callback({ success: false, message: '플레이어 정원(10명)이 찼습니다.' });
    }

    if (isObserver) {
      if (!room.observers) room.observers = {};
      room.observers[userId] = {
        userId,
        nickname: `${nickname} (관전)`,
        socketId: socket.id
      };
      // 만약 플레이어로 들어있었다면 제거
      if (room.players[userId]) {
        delete room.players[userId];
        room.playerOrder = room.playerOrder.filter(id => id !== userId);
      }
    } else {
      if (!room.players[userId]) {
        room.players[userId] = {
          userId,
          nickname,
          socketId: socket.id,
          connected: true,
          goldCards: [],
          tools: { pickaxe: true, lantern: true, cart: true },
          role: null,
          hand: []
        };
        room.playerOrder.push(userId);
      } else {
        room.players[userId].connected = true;
        room.players[userId].socketId = socket.id;
      }
      if (room.observers && room.observers[userId]) {
        delete room.observers[userId];
      }
    }

    db.setUserActiveRoom(userId, roomId);
    socket.join(roomId);
    if (callback) callback({ success: true, roomId, isObserver });
    io.emit('room_list_update', getRoomPublicList());
    broadcastRoomState(room);
  });

  socket.on('leave_room', (callback) => {
    const user = db.getUserById(userId);
    if (user?.activeRoomId && rooms[user.activeRoomId]) {
      const room = rooms[user.activeRoomId];
      if (room.players[userId]) {
        delete room.players[userId];
        room.playerOrder = room.playerOrder.filter(id => id !== userId);
      }
      if (room.observers && room.observers[userId]) {
        delete room.observers[userId];
      }
      db.setUserActiveRoom(userId, null);
      socket.leave(room.id);

      if (room.hostId === userId) {
        if (room.playerOrder.length > 0) {
          room.hostId = room.playerOrder[0];
          room.hostName = room.players[room.hostId].nickname;
        } else {
          delete rooms[room.id];
        }
      }
      if (rooms[room.id]) broadcastRoomState(room);
      io.emit('room_list_update', getRoomPublicList());
    }
    if (callback) callback({ success: true });
  });

  // 실시간 채팅 메시지
  socket.on('send_chat', ({ text }) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || !text || !text.trim()) return;

    const isObs = Boolean(room.observers && room.observers[userId]);
    const senderName = isObs ? `${nickname} (관전)` : nickname;

    io.to(room.id).emit('chat_message', {
      senderId: userId,
      senderNickname: senderName,
      isObserver: isObs,
      text: text.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // 동적 인원 게임 시작 (3~10인)
  socket.on('start_game', (callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.hostId !== userId) return callback && callback({ success: false, message: '방장 권한 필요' });

    const count = room.playerOrder.length;
    if (count < 3 || count > 10) {
      return callback && callback({ success: false, message: '사보타지는 3명에서 10명까지만 시작 가능합니다.' });
    }

    room.round = 1;
    room.playerOrder.forEach(uid => { room.players[uid].goldCards = []; });
    startNewRound(room);

    if (callback) callback({ success: true });
    io.emit('room_list_update', getRoomPublicList());
    broadcastRoomState(room);
  });

  socket.on('next_round', (callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.hostId !== userId || room.status !== 'ROUND_END') return;

    room.round += 1;
    startNewRound(room);
    if (callback) callback({ success: true });
    broadcastRoomState(room);
  });

  socket.on('claim_gold_card', ({ cardId }, callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.status !== 'GOLD_DRAFT') return;

    const currentDrafter = room.goldDraft.order[room.goldDraft.currentIdx];
    if (currentDrafter !== userId) return callback && callback({ success: false, message: '선택 순서가 아닙니다.' });

    const cardIdx = room.goldDraft.pool.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return callback && callback({ success: false, message: '해당 카드 없음' });

    const [chosen] = room.goldDraft.pool.splice(cardIdx, 1);
    room.players[userId].goldCards.push(chosen);

    room.goldDraft.currentIdx += 1;
    if (room.goldDraft.currentIdx >= room.goldDraft.order.length || room.goldDraft.pool.length === 0) {
      finalizeRoundEnd(room, 'MINERS', room.goldDraft.reasonMsg);
    }

    if (callback) callback({ success: true });
    broadcastRoomState(room);
  });

  socket.on('send_reaction', ({ emoji }) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (room) {
      io.to(room.id).emit('player_reaction', { userId, emoji });
    }
  });

  // 통로 카드 놓기 (공식 룰: 오픈 카드와 변만 맞으면 연결 끊겨도 놓기 가능)
  socket.on('play_path_card', ({ cardId, row, col, isRotated }, callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.status !== 'PLAYING') return;

    if (room.playerOrder[room.turnIdx] !== userId) return callback && callback({ success: false, message: '내 턴이 아닙니다.' });

    const player = room.players[userId];
    const broken = Object.entries(player.tools).filter(([_, ok]) => !ok).map(([t]) => t);
    if (broken.length > 0) return callback && callback({ success: false, message: `도구 파손으로 길을 놓을 수 없습니다! (${broken.join(', ')})` });

    const cIdx = player.hand.findIndex(c => c.id === cardId);
    if (cIdx === -1) return callback && callback({ success: false, message: '카드 없음' });

    let card = { ...player.hand[cIdx] };
    if (card.type !== 'PATH') return callback && callback({ success: false, message: '통로 카드 아님' });
    if (isRotated) card = engine.rotateCard(card);

    const check = engine.validatePathPlacement(room.board, room.destinations, row, col, card);
    if (!check.valid) return callback && callback({ success: false, message: check.reason });

    room.board[row][col] = card;
    player.hand.splice(cIdx, 1);
    if (room.deck.length > 0) player.hand.push(room.deck.pop());

    room.lastAction = { message: `${player.nickname} 님이 (${row}, ${col})에 [${card.name}]를 놓았습니다.` };

    // 목적지 접촉 및 뒤집기 (출발지로부터 연결된 길일 때에만 오픈!)
    const flips = engine.checkDestinationFlip(room.board, room.destinations, row, col);
    if (flips?.length > 0) {
      flips.forEach(f => {
        if (f.isGold) {
          endRound(room, 'MINERS', userId, `${player.nickname} 님이 진짜 금광을 연결했습니다!`);
        } else {
          room.lastAction.message += ` ⚠️ ${f.actualCard.name}이 드러났습니다!`;
        }
      });
    }

    if (room.status === 'PLAYING') advanceTurn(room);
    if (callback) callback({ success: true });
    broadcastRoomState(room);
  });

  // 행동 카드 사용
  socket.on('play_action_card', ({ cardId, targetUserId, destId, rockfallRow, rockfallCol }, callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.status !== 'PLAYING') return;
    if (room.playerOrder[room.turnIdx] !== userId) return callback && callback({ success: false, message: '내 턴이 아닙니다.' });

    const player = room.players[userId];
    const cIdx = player.hand.findIndex(c => c.id === cardId);
    if (cIdx === -1) return callback && callback({ success: false, message: '카드 없음' });

    const card = player.hand[cIdx];

    if (card.action === 'TORN_MAP') {
      return callback && callback({ success: false, message: '찢어진 지도는 사용할 수 없습니다! 버리기만 가능합니다.' });
    }

    if (card.action === 'BLOCK') {
      const target = room.players[targetUserId];
      if (!target || !target.tools[card.tool]) return callback && callback({ success: false, message: '이미 파손되었거나 대상 없음' });
      target.tools[card.tool] = false;
      room.lastAction = { message: `🔨 ${player.nickname} 님이 ${target.nickname}의 [${card.tool}]를 파손시켰습니다!` };
    } else if (card.action === 'FIX') {
      const target = room.players[targetUserId];
      if (!target) return callback && callback({ success: false, message: '대상을 찾을 수 없습니다.' });

      // 공식 룰 1번: 2개 수리 카드는 둘 다 모두 수리함!
      const repairableTools = card.tools.filter(t => target.tools[t] === false);
      if (repairableTools.length === 0) {
        return callback && callback({ success: false, message: '해당 카드로 수리할 수 있는 고장난 도구가 없습니다.' });
      }

      // 해당되는 모든 도구 복구!
      card.tools.forEach(t => { target.tools[t] = true; });
      room.lastAction = { message: `🔧 ${player.nickname} 님이 ${target.nickname}의 [${repairableTools.join(', ')}]를 수리했습니다!` };
    } else if (card.action === 'MAP') {
      const dest = room.destinations[destId];
      if (!dest || dest.revealed) return callback && callback({ success: false, message: '확인할 수 없는 목적지' });
      dest.inspectedBy = player.nickname;

      // 실제 카드의 길 모양(open)과 정체를 클라이언트에 전달하여 팝업 렌더링
      socket.emit('secret_destination_peek', {
        destLabel: dest.label,
        isGold: dest.isGold,
        card: dest.actualCard
      });
      room.lastAction = { message: `🗺️ ${player.nickname} 님이 [${dest.label}]를 몰래 확인했습니다!` };
    } else if (card.action === 'ROCKFALL') {
      if (rockfallRow === engine.START_POS.row && rockfallCol === engine.START_POS.col) return callback && callback({ success: false, message: '출발지는 파괴 불가' });
      const t = room.board[rockfallRow][rockfallCol];
      if (!t || t.type !== 'PATH') return callback && callback({ success: false, message: '파괴할 수 있는 통로가 아닙니다.' });
      room.board[rockfallRow][rockfallCol] = null;
      room.lastAction = { message: `🪨 ${player.nickname} 님이 (${rockfallRow}, ${rockfallCol}) 통로를 파괴했습니다!` };
    }

    room.discardPile.push({ card: { ...card } });
    player.hand.splice(cIdx, 1);
    if (room.deck.length > 0) player.hand.push(room.deck.pop());

    advanceTurn(room);
    if (callback) callback({ success: true });
    broadcastRoomState(room);
  });

  // 공식 룰 6번: 카드는 뒷면으로 버림 (정체 비공개)
  socket.on('discard_card', ({ cardId }, callback) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || room.status !== 'PLAYING') return;
    if (room.playerOrder[room.turnIdx] !== userId) return callback && callback({ success: false, message: '내 턴이 아닙니다.' });

    const player = room.players[userId];
    const cIdx = player.hand.findIndex(c => c.id === cardId);
    if (cIdx === -1) return callback && callback({ success: false, message: '카드 없음' });

    const disc = player.hand[cIdx];
    room.discardPile.push({ card: disc });
    player.hand.splice(cIdx, 1);
    if (room.deck.length > 0) player.hand.push(room.deck.pop());

    room.lastDiscardedText = `${player.nickname} 님이 카드 1장을 뒷면으로 버렸습니다.`;
    room.lastAction = { message: `🗑️ ${player.nickname} 님이 카드를 뒷면으로 버리고 턴을 넘겼습니다.` };

    advanceTurn(room);
    if (callback) callback({ success: true });
    broadcastRoomState(room);
  });

  
  // 게임 중단(조기 종료) 투표 시스템
  socket.on('request_end_game_vote', () => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || (room.status !== 'PLAYING' && room.status !== 'GOLD_DRAFT')) return;

    // 이미 투표가 진행 중인 경우 무시
    if (room.endGameVote) return;

    room.endGameVote = {
      initiatorId: userId,
      initiatorName: nickname,
      votes: { [userId]: true }
    };

    io.to(room.id).emit('end_game_vote_started', {
      initiatorName: nickname,
      currentVotes: 1,
      totalRequired: room.playerOrder.length
    });
  });

  socket.on('cast_end_game_vote', ({ agree }) => {
    const user = db.getUserById(userId);
    const room = rooms[user?.activeRoomId];
    if (!room || !room.endGameVote) return;

    if (!agree) {
      // 한 명이라도 반대하면 투표 즉시 취소
      const voterName = nickname;
      room.endGameVote = null;
      io.to(room.id).emit('end_game_vote_cancelled', { voterName });
      return;
    }

    room.endGameVote.votes[userId] = true;
    const currentCount = Object.keys(room.endGameVote.votes).length;
    const totalRequired = room.playerOrder.length;

    io.to(room.id).emit('end_game_vote_updated', {
      currentVotes: currentCount,
      totalRequired: totalRequired
    });

    // 전원 동기 완료 시 게임 즉시 종료!
    if (currentCount >= totalRequired) {
      room.endGameVote = null;
      room.status = 'GAME_END';
      room.roundResult = {
        winningTeam: 'DRAW',
        reason: '모든 플레이어가 동의하여 게임이 조기 종료되었습니다.',
        isFinalRound: true
      };
      room.lastAction = { message: '🛑 전원 동의로 게임이 종료되었습니다.' };
      broadcastRoomState(room);
    }
  });

  socket.on('disconnect', () => {
    const user = db.getUserById(userId);
    if (user?.activeRoomId && rooms[user.activeRoomId]) {
      const room = rooms[user.activeRoomId];
      if (room.players[userId]) {
        room.players[userId].connected = false;
        broadcastRoomState(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Saboteur Game Server v2.0] Running on http://localhost:${PORT}`);
});
