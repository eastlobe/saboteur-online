// gameEngine.js - 사보타지 원작 공식 룰 100% 엔진
const ROLE_SETTINGS = {
  3: { miners: 3, saboteurs: 1 },
  4: { miners: 4, saboteurs: 1 },
  5: { miners: 4, saboteurs: 2 },
  6: { miners: 5, saboteurs: 2 },
  7: { miners: 5, saboteurs: 3 },
  8: { miners: 6, saboteurs: 3 },
  9: { miners: 7, saboteurs: 3 },
  10: { miners: 7, saboteurs: 4 }
};

const HAND_SIZES = { 3: 6, 4: 6, 5: 6, 6: 5, 7: 5, 8: 4, 9: 4, 10: 4 };

const BOARD_ROWS = 9;
const BOARD_COLS = 11;
const START_POS = { row: 4, col: 1 };
const DEST_POSITIONS = [
  { id: 'dest_0', row: 2, col: 9, label: '상단 목적지' },
  { id: 'dest_1', row: 4, col: 9, label: '중앙 목적지' },
  { id: 'dest_2', row: 6, col: 9, label: '하단 목적지' }
];

// 방향 정의: 0=상, 1=우, 2=하, 3=좌
const DIRS = [
  { dr: -1, dc: 0, opp: 2 },
  { dr: 0, dc: 1, opp: 3 },
  { dr: 1, dc: 0, opp: 0 },
  { dr: 0, dc: -1, opp: 1 }
];

function createDeck(mapCardCount = 6) {
  const cards = [];
  let id = 1;

  const validMapCount = Math.max(0, Math.min(6, Number(mapCardCount)));
  const tornMapCount = 6 - validMapCount;

  // 1. 행동 카드 (27장)
  const actionDefs = [
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'pickaxe', name: '곡괭이 파괴' },
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'lantern', name: '등불 파괴' },
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'cart', name: '수레 파괴' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['pickaxe'], name: '곡괭이 수리' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['lantern'], name: '등불 수리' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['cart'], name: '수레 수리' },
    // 복합 수리 카드는 공식 룰상 2개 도구를 '동시에 모두' 수리함
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['pickaxe', 'lantern'], name: '곡괭이+등불 수리' },
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['pickaxe', 'cart'], name: '곡괭이+수레 수리' },
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['lantern', 'cart'], name: '등불+수레 수리' },
    { count: validMapCount, type: 'ACTION', action: 'MAP', name: '비밀 지도' },
    { count: tornMapCount, type: 'ACTION', action: 'TORN_MAP', name: '찢어진 지도' },
    { count: 3, type: 'ACTION', action: 'ROCKFALL', name: '낙석' }
  ];

  actionDefs.forEach(def => {
    for (let i = 0; i < def.count; i++) {
      cards.push({ ...def, id: `c_${id++}` });
    }
  });

  // 2. 통로 카드 (40장: 정상 25장 + 막다른 15장)
  const pathDefs = [
    { count: 5, open: [true, true, true, true], deadEnd: false, name: '십자 통로' },
    { count: 5, open: [true, true, false, true], deadEnd: false, name: 'T자 삼거리 A' },
    { count: 5, open: [true, false, true, true], deadEnd: false, name: 'T자 삼거리 B' },
    { count: 3, open: [true, false, true, false], deadEnd: false, name: '직선(세로)' },
    { count: 1, open: [false, true, false, true], deadEnd: false, name: '직선(가로)' },
    { count: 5, open: [true, true, false, false], deadEnd: false, name: '코너 통로 A' },
    { count: 1, open: [false, true, true, false], deadEnd: false, name: '코너 통로 B' },
    { count: 1, open: [true, true, true, true], deadEnd: true, name: '십자 막다른' },
    { count: 2, open: [true, true, false, true], deadEnd: true, name: 'T자 막다른' },
    { count: 2, open: [true, false, true, false], deadEnd: true, name: '직선 막다른(세로)' },
    { count: 2, open: [false, true, false, true], deadEnd: true, name: '직선 막다른(가로)' },
    { count: 2, open: [true, true, false, false], deadEnd: true, name: '코너 막다른' },
    { count: 2, open: [true, false, false, false], deadEnd: true, name: '외길 막다른(상)' },
    { count: 2, open: [false, false, false, true], deadEnd: true, name: '외길 막다른(좌)' },
    { count: 2, open: [false, true, false, false], deadEnd: true, name: '외길 막다른(우)' }
  ];

  pathDefs.forEach(def => {
    for (let i = 0; i < def.count; i++) {
      cards.push({ ...def, type: 'PATH', id: `c_${id++}` });
    }
  });

  return cards;
}

function createGoldDeck() {
  const deck = [];
  let gId = 1;
  for (let i = 0; i < 4; i++) deck.push({ id: `gold_${gId++}`, value: 3 });
  for (let i = 0; i < 8; i++) deck.push({ id: `gold_${gId++}`, value: 2 });
  for (let i = 0; i < 16; i++) deck.push({ id: `gold_${gId++}`, value: 1 });
  return shuffle(deck);
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rotateCard(card) {
  if (!card || !card.open) return card;
  return {
    ...card,
    open: [card.open[2], card.open[3], card.open[0], card.open[1]],
    isRotated: !card.isRotated
  };
}

function createInitialBoard() {
  const board = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));

  board[START_POS.row][START_POS.col] = {
    type: 'START',
    open: [true, true, true, true],
    deadEnd: false,
    name: '출발지(사다리)'
  };

  const destTypes = shuffle(['GOLD', 'COAL_1', 'COAL_2']);
  const destinations = {};

  DEST_POSITIONS.forEach((pos, idx) => {
    const isGold = destTypes[idx] === 'GOLD';
    let actualCard;
    if (isGold) {
      actualCard = { type: 'PATH', open: [true, true, true, true], deadEnd: false, name: '진짜 금광 💰', isGold: true };
    } else if (destTypes[idx] === 'COAL_1') {
      // 하-좌 ㄱ자 코너
      actualCard = { type: 'PATH', open: [false, false, true, true], deadEnd: false, name: '석탄(하-좌 ㄱ자) 🪨', isCoal: true };
    } else {
      // 상-좌 선대칭 ㄱ자 코너
      actualCard = { type: 'PATH', open: [true, false, false, true], deadEnd: false, name: '석탄(상-좌 ㄱ자) 🪨', isCoal: true };
    }

    destinations[pos.id] = {
      id: pos.id,
      row: pos.row,
      col: pos.col,
      label: pos.label,
      type: 'DESTINATION',
      isGold: isGold,
      actualCard: actualCard,
      revealed: false
    };

    board[pos.row][pos.col] = {
      type: 'DESTINATION_HIDDEN',
      destId: pos.id
    };
  });

  return { board, destinations };
}

// 공식 룰 8번 반영:
// 오픈된 기존 카드와 모순 없이 연결되기만 하면 출발지와 끊겨 있어도 길 카드 배치 가능!
// 단, 오직 뒷면 목적지 카드에만 단독으로 맞닿는 공중부양 배치는 금지.
function validatePathPlacement(board, destinations, row, col, card) {
  if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) {
    return { valid: false, reason: '보드 범위를 벗어났습니다.' };
  }

  if (board[row][col] !== null) {
    return { valid: false, reason: '이미 카드가 놓여있는 위치입니다.' };
  }

  let hasOpenNeighbor = false;

  for (let dir = 0; dir < 4; dir++) {
    const nr = row + DIRS[dir].dr;
    const nc = col + DIRS[dir].dc;
    if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;

    const neighbor = board[nr][nc];
    if (!neighbor) continue;

    if (neighbor.type === 'DESTINATION_HIDDEN') {
      // 뒷면 목적지 카드는 인접 연결 인정 대상에서 제외 (뒷면에만 단독 연결 불가)
      continue;
    }

    // 오픈된 카드(출발지, 일반 통로, 공개된 목적지)와 인접함
    hasOpenNeighbor = true;
    const opp = DIRS[dir].opp;
    const myOpen = Boolean(card.open[dir]);
    const neighborOpen = Boolean(neighbor.open && neighbor.open[opp]);

    // 맞닿는 모든 변의 길과 벽이 일치해야 함
    if (myOpen !== neighborOpen) {
      return { valid: false, reason: '인접한 통로와 맞닿는 변의 길/벽이 일치하지 않습니다.' };
    }
  }

  if (!hasOpenNeighbor) {
    return { valid: false, reason: '이미 놓인 오픈 통로 카드와 적어도 한 변 이상 맞닿아야 합니다.' };
  }

  return { valid: true };
}

// 출발지로부터 (targetRow, targetCol)까지 열린 통로로 이어지는지 2D BFS 검사
function checkConnectionToStart(board, targetRow, targetCol) {
  const queue = [{ r: START_POS.row, c: START_POS.col }];
  const visited = new Set();
  visited.add(`${START_POS.row},${START_POS.col}`);

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr.r === targetRow && curr.c === targetCol) return true;

    const currTile = board[curr.r][curr.c];
    if (!currTile || !currTile.open) continue;

    if (currTile.deadEnd && (curr.r !== START_POS.row || curr.c !== START_POS.col)) {
      continue;
    }

    for (let dir = 0; dir < 4; dir++) {
      if (!currTile.open[dir]) continue;

      const nr = curr.r + DIRS[dir].dr;
      const nc = curr.c + DIRS[dir].dc;
      if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;

      const key = `${nr},${nc}`;
      if (visited.has(key)) continue;

      const neighbor = board[nr][nc];
      if (!neighbor) continue;

      const opp = DIRS[dir].opp;
      if (neighbor.open && neighbor.open[opp]) {
        visited.add(key);
        queue.push({ r: nr, c: nc });
      }
    }
  }

  return visited.has(`${targetRow},${targetCol}`);
}

// 목적지 뒤집기 판정 (반드시 출발지로부터 연결된 통로가 도달했을 때에만 뒤집힘!)
function checkDestinationFlip(board, destinations, placedRow, placedCol) {
  const placedTile = board[placedRow][placedCol];
  if (!placedTile || !placedTile.open) return null;

  const revealed = [];
  for (let dir = 0; dir < 4; dir++) {
    if (!placedTile.open[dir]) continue;

    const nr = placedRow + DIRS[dir].dr;
    const nc = placedCol + DIRS[dir].dc;
    if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;

    const neighbor = board[nr][nc];
    if (neighbor && neighbor.type === 'DESTINATION_HIDDEN') {
      const dest = destinations[neighbor.destId];
      if (dest && !dest.revealed) {
        // 반드시 출발지로부터 현재 놓인 타일까지 열린 통로로 이어져 있는지 엄격히 검증!
        if (checkConnectionToStart(board, placedRow, placedCol)) {
          dest.revealed = true;
          let actualCard = { ...dest.actualCard };
          const opp = DIRS[dir].opp; // 목적지 입장에서 진입된 변

          // 진입된 변이 닫혀 있다면 180도 회전시켜 통로에 자연스럽게 잇기
          if (!actualCard.open[opp]) {
            actualCard = rotateCard(actualCard);
          }

          dest.actualCard = actualCard;
          board[nr][nc] = actualCard;
          revealed.push({
            destId: dest.id,
            row: nr,
            col: nc,
            isGold: dest.isGold,
            actualCard: actualCard
          });
        }
      }
    }
  }
  return revealed;
}

module.exports = {
  ROLE_SETTINGS,
  HAND_SIZES,
  BOARD_ROWS,
  BOARD_COLS,
  START_POS,
  DEST_POSITIONS,
  createDeck,
  createGoldDeck,
  shuffle,
  rotateCard,
  createInitialBoard,
  validatePathPlacement,
  checkConnectionToStart,
  checkDestinationFlip
};
