// gameEngine.js - 사보타지 원작 정밀 규칙 엔진
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

const DIRS = [
  { dr: -1, dc: 0, opp: 2 }, // 상 (0) -> 하 (2)
  { dr: 0, dc: 1, opp: 3 },  // 우 (1) -> 좌 (3)
  { dr: 1, dc: 0, opp: 0 },  // 하 (2) -> 상 (0)
  { dr: 0, dc: -1, opp: 1 }  // 좌 (3) -> 우 (1)
];

function createDeck() {
  const cards = [];
  let idCounter = 1;

  const actionDefs = [
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'pickaxe', name: '곡괭이 파괴' },
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'lantern', name: '등불 파괴' },
    { count: 3, type: 'ACTION', action: 'BLOCK', tool: 'cart', name: '수레 파괴' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['pickaxe'], name: '곡괭이 수리' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['lantern'], name: '등불 수리' },
    { count: 2, type: 'ACTION', action: 'FIX', tools: ['cart'], name: '수레 수리' },
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['pickaxe', 'lantern'], name: '곡괭이/등불 수리' },
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['pickaxe', 'cart'], name: '곡괭이/수레 수리' },
    { count: 1, type: 'ACTION', action: 'FIX', tools: ['lantern', 'cart'], name: '등불/수레 수리' },
    { count: 6, type: 'ACTION', action: 'MAP', name: '비밀 지도' },
    { count: 3, type: 'ACTION', action: 'ROCKFALL', name: '낙석' }
  ];

  actionDefs.forEach(def => {
    for (let i = 0; i < def.count; i++) {
      cards.push({ ...def, id: `c_${idCounter++}` });
    }
  });

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
      cards.push({ ...def, type: 'PATH', id: `c_${idCounter++}` });
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
    
    // 원작 사보타지 목적지 카드 스펙:
    // 금광: 십자 통로 [true, true, true, true]
    // 석탄 1: 하-좌 ㄱ자 코너 [false, false, true, true]
    // 석탄 2: 상-좌 선대칭 ㄱ자 코너 [true, false, false, true]
    let actualCard;
    if (isGold) {
      actualCard = { type: 'PATH', open: [true, true, true, true], deadEnd: false, name: '진짜 금광 💰', isGold: true };
    } else if (destTypes[idx] === 'COAL_1') {
      actualCard = { type: 'PATH', open: [false, false, true, true], deadEnd: false, name: '석탄(하-좌 ㄱ자) 🪨', isCoal: true };
    } else {
      actualCard = { type: 'PATH', open: [true, false, false, true], deadEnd: false, name: '석탄(상-좌 ㄱ자) 🪨', isCoal: true };
    }

    const destCard = {
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
    destinations[pos.id] = destCard;
  });

  return { board, destinations };
}

function validatePathPlacement(board, destinations, row, col, card) {
  if (row < 0 || row >= BOARD_ROWS || col < 0 || col >= BOARD_COLS) {
    return { valid: false, reason: '보드 범위를 벗어났습니다.' };
  }

  if (board[row][col] !== null) {
    return { valid: false, reason: '이미 카드가 놓여있는 위치입니다.' };
  }

  let hasAdjacent = false;
  for (let dir = 0; dir < 4; dir++) {
    const nr = row + DIRS[dir].dr;
    const nc = col + DIRS[dir].dc;
    if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;

    const neighbor = board[nr][nc];
    if (!neighbor) continue;

    if (neighbor.type === 'DESTINATION_HIDDEN') {
      hasAdjacent = true;
      continue;
    }

    hasAdjacent = true;
    const opp = DIRS[dir].opp;
    const myOpen = Boolean(card.open[dir]);
    const neighborOpen = Boolean(neighbor.open && neighbor.open[opp]);

    if (myOpen !== neighborOpen) {
      return { valid: false, reason: '인접한 통로와 벽/길이 맞지 않습니다.' };
    }
  }

  if (!hasAdjacent) {
    return { valid: false, reason: '기존에 놓인 통로와 연결되어야 합니다.' };
  }

  board[row][col] = card;
  const connected = checkConnectionToStart(board, row, col);
  board[row][col] = null;

  if (!connected) {
    return { valid: false, reason: '출발지(사다리)로부터 이어진 길이어야 합니다.' };
  }

  return { valid: true };
}

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

// 목적지 접촉 시 자동 회전하여 길에 이어지도록 배치
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
        if (checkConnectionToStart(board, placedRow, placedCol)) {
          dest.revealed = true;
          let actualCard = { ...dest.actualCard };
          const opp = DIRS[dir].opp; // 목적지 입장에서 진입된 방향

          // 진입된 방향의 변이 막혀있다면 180도 회전시켜 연결!
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
