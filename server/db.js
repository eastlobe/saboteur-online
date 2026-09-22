// db.js - 사용자 계정, 세션 및 재접속 방 매핑 영속화 모듈
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let users = {};

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      users = JSON.parse(data);
    } catch (err) {
      console.error('Error reading users file:', err);
      users = {};
    }
  } else {
    users = {};
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving users file:', err);
  }
}

loadUsers();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateToken(userId) {
  const payload = {
    userId,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7일 유효
  };
  const str = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', 'SABOTEUR_SECRET_KEY_2026').update(str).digest('hex');
  return Buffer.from(str).toString('base64url') + '.' + signature;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  try {
    const [payloadB64, sig] = parts;
    const str = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const expectedSig = crypto.createHmac('sha256', 'SABOTEUR_SECRET_KEY_2026').update(str).digest('hex');
    if (sig !== expectedSig) return null;

    const payload = JSON.parse(str);
    if (payload.exp < Date.now()) return null;
    return payload.userId;
  } catch (err) {
    return null;
  }
}

function registerUser(username, password, nickname) {
  if (!username || !password || !nickname) {
    return { success: false, message: '모든 입력 항목을 채워주세요.' };
  }
  const cleanUsername = username.trim().toLowerCase();
  if (users[cleanUsername]) {
    return { success: false, message: '이미 존재하는 아이디입니다.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');

  users[cleanUsername] = {
    userId,
    username: cleanUsername,
    nickname: nickname.trim(),
    salt,
    passwordHash,
    activeRoomId: null,
    createdAt: new Date().toISOString()
  };

  saveUsers();
  const token = generateToken(userId);
  return {
    success: true,
    token,
    user: {
      userId,
      username: cleanUsername,
      nickname: nickname.trim(),
      activeRoomId: null
    }
  };
}

function loginUser(username, password) {
  if (!username || !password) {
    return { success: false, message: '아이디와 비밀번호를 입력해주세요.' };
  }
  const cleanUsername = username.trim().toLowerCase();
  const user = users[cleanUsername];
  if (!user) {
    return { success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' };
  }

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return { success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' };
  }

  const token = generateToken(user.userId);
  return {
    success: true,
    token,
    user: {
      userId: user.userId,
      username: user.username,
      nickname: user.nickname,
      activeRoomId: user.activeRoomId
    }
  };
}

function getUserById(userId) {
  for (const key of Object.keys(users)) {
    if (users[key].userId === userId) {
      return users[key];
    }
  }
  return null;
}

function getUserByToken(token) {
  const userId = verifyToken(token);
  if (!userId) return null;
  const user = getUserById(userId);
  if (!user) return null;
  return {
    userId: user.userId,
    username: user.username,
    nickname: user.nickname,
    activeRoomId: user.activeRoomId
  };
}

function setUserActiveRoom(userId, roomId) {
  const user = getUserById(userId);
  if (user) {
    user.activeRoomId = roomId;
    saveUsers();
  }
}

module.exports = {
  registerUser,
  loginUser,
  getUserByToken,
  getUserById,
  setUserActiveRoom
};
