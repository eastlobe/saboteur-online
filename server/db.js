// db.js - Render 슬립/재부팅 환경에서도 세션과 계정이 영구 유지되는 스마트 영속화 모듈
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
    console.error('Save users failed:', err);
  }
}

loadUsers();

const SECRET_KEY = 'SABOTEUR_SECRET_KEY_PERMANENT_2026';

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

// 토큰 안에 유저 정보를 안전하게 암호화/서명하여, 서버가 재부팅되어도 토큰만으로 계정 자동 복구 가능!
function generateToken(user) {
  const payload = {
    userId: user.userId,
    username: user.username,
    nickname: user.nickname,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30일 유효
  };
  const str = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(str).digest('hex');
  return Buffer.from(str).toString('base64url') + '.' + signature;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  try {
    const [payloadB64, sig] = parts;
    const str = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(str).digest('hex');
    if (sig !== expectedSig) return null;

    const payload = JSON.parse(str);
    if (payload.exp < Date.now()) return null;
    return payload; // { userId, username, nickname }
  } catch (err) {
    return null;
  }
}

function registerUser(username, password, nickname) {
  if (!username || !password || !nickname) {
    return { success: false, message: '모든 항목을 입력해주세요.' };
  }
  const cleanUsername = username.trim().toLowerCase();
  if (users[cleanUsername]) {
    return { success: false, message: '이미 존재하는 아이디입니다.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');

  const newUser = {
    userId,
    username: cleanUsername,
    nickname: nickname.trim(),
    salt,
    passwordHash,
    activeRoomId: null,
    createdAt: new Date().toISOString()
  };

  users[cleanUsername] = newUser;
  saveUsers();

  const token = generateToken(newUser);
  return {
    success: true,
    token,
    user: {
      userId: newUser.userId,
      username: newUser.username,
      nickname: newUser.nickname,
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

  const token = generateToken(user);
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

// 스마트 복구: 서버가 슬립 후 깨어나서 users 메모리가 비었더라도, 유효한 서명 토큰이면 즉시 계정 복구!
function getUserByToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;

  let user = getUserById(payload.userId);
  if (!user) {
    // 자동 복원
    user = {
      userId: payload.userId,
      username: payload.username,
      nickname: payload.nickname,
      salt: '',
      passwordHash: '',
      activeRoomId: null,
      createdAt: new Date().toISOString()
    };
    users[payload.username] = user;
    saveUsers();
  }

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
