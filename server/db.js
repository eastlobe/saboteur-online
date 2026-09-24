// db.js - Firebase Realtime Database (relaynovelphobia) 100% 직결 영구 저장 모듈
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let localUsers = {};

function loadLocalUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      localUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) { localUsers = {}; }
  }
}

function saveLocalUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(localUsers, null, 2), 'utf8');
  } catch (e) {}
}

loadLocalUsers();

const SECRET_KEY = 'SABOTEUR_SECRET_KEY_PERMANENT_2026';

// 사용자 지정 Firebase Realtime Database URL
const FIREBASE_DB_URL = 'https://relaynovelphobia-default-rtdb.firebaseio.com';

function requestJson(url, method = 'GET', data = null) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 4000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ status: res.statusCode, data: null });
          }
        });
      });

      req.on('error', () => resolve({ status: 500, data: null }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 408, data: null }); });

      if (data) req.write(JSON.stringify(data));
      req.end();
    } catch (e) {
      resolve({ status: 500, data: null });
    }
  });
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

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
    return payload;
  } catch (err) {
    return null;
  }
}

// Firebase RTDB 및 로컬 캐시에서 유저 조회
async function fetchUser(username) {
  const clean = username.trim().toLowerCase();
  // 1. 로컬 메모리/파일 캐시
  if (localUsers[clean]) return localUsers[clean];

  // 2. Firebase Realtime Database 조회
  const res = await requestJson(`${FIREBASE_DB_URL}/saboteur_users/${clean}.json`);
  if (res.status === 200 && res.data) {
    localUsers[clean] = res.data;
    saveLocalUsers();
    return res.data;
  }
  return null;
}

// Firebase RTDB 및 로컬에 영구 저장
async function saveUser(user) {
  const clean = user.username.trim().toLowerCase();
  localUsers[clean] = user;
  saveLocalUsers();

  // Firebase Realtime Database saboteur_users 노드에 PUT
  requestJson(`${FIREBASE_DB_URL}/saboteur_users/${clean}.json`, 'PUT', user);
}

async function registerUser(username, password, nickname) {
  if (!username || !password || !nickname) {
    return { success: false, message: '모든 항목을 입력해주세요.' };
  }
  const clean = username.trim().toLowerCase();
  const existing = await fetchUser(clean);
  if (existing) {
    return { success: false, message: '이미 존재하는 아이디입니다.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const userId = 'u_' + crypto.randomBytes(6).toString('hex');

  const newUser = {
    userId,
    username: clean,
    nickname: nickname.trim(),
    salt,
    passwordHash,
    activeRoomId: null,
    createdAt: new Date().toISOString()
  };

  await saveUser(newUser);
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

async function loginUser(username, password) {
  if (!username || !password) {
    return { success: false, message: '아이디와 비밀번호를 입력해주세요.' };
  }
  const clean = username.trim().toLowerCase();
  const user = await fetchUser(clean);

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
  for (const k of Object.keys(localUsers)) {
    if (localUsers[k].userId === userId) return localUsers[k];
  }
  return null;
}

function getUserByToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;

  let user = getUserById(payload.userId);
  if (!user) {
    user = {
      userId: payload.userId,
      username: payload.username,
      nickname: payload.nickname,
      salt: '',
      passwordHash: '',
      activeRoomId: null,
      createdAt: new Date().toISOString()
    };
    saveUser(user);
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
    saveUser(user);
  }
}

module.exports = {
  registerUser,
  loginUser,
  getUserByToken,
  getUserById,
  setUserActiveRoom
};
