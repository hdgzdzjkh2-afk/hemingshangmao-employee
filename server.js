const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ==================== 配置区 ====================
// 微信开放平台（open.weixin.qq.com）网站应用凭证
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';
// 回调地址必须已在微信开放平台配置
const WECHAT_CALLBACK = process.env.WECHAT_CALLBACK || 'http://localhost:3001/auth/wechat/callback';
// 是否为开发模式（无微信凭据时自动启用模拟登录）
const DEV_MODE = !WECHAT_APPID || !WECHAT_SECRET || process.argv.includes('--dev');

// ==================== 数据存储 ====================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const EMPLOYEES_FILE = path.join(DATA_DIR, 'employees.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// 数据迁移：旧 employment_type 值转换
function migrateData() {
  const employees = readJSON(EMPLOYEES_FILE);
  let changed = false;
  employees.forEach(e => {
    if (e.employment_type === '正式') { e.employment_type = '已转正'; changed = true; }
    else if (e.employment_type === '试用') { e.employment_type = '未转正'; changed = true; }
  });
  if (changed) writeJSON(EMPLOYEES_FILE, employees);
}
migrateData();

// ==================== 中间件 ====================
const BASE_PATH = '/hemingshangmaokuajingdianrenyuanguilei';
app.use(express.json({ limit: '10mb' }));
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect(BASE_PATH));

// JWT 认证中间件
function authRequired(req, res, next) {
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// Cookie 解析（简单实现）
app.use((req, res, next) => {
  req.cookies = {};
  const cookie = req.headers.cookie;
  if (cookie) {
    cookie.split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      req.cookies[k] = decodeURIComponent(v);
    });
  }
  next();
});

// ==================== 微信登录 ====================
// 发起微信登录
app.get('/auth/wechat', (req, res) => {
  if (!WECHAT_APPID) {
    return res.redirect(`${BASE_PATH}/?error=no_wechat_config`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(WECHAT_CALLBACK);
  const url = `https://open.weixin.qq.com/connect/qrconnect?appid=${WECHAT_APPID}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
  // 存储 state 用于验证（简化：存内存）
  app.locals.wechatState = state;
  res.redirect(url);
});

// 微信回调
app.get('/auth/wechat/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect(`${BASE_PATH}/?error=no_code`);
  if (state !== app.locals.wechatState) return res.redirect(`${BASE_PATH}/?error=state_mismatch`);

  try {
    // 1. 用 code 换 access_token
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&code=${code}&grant_type=authorization_code`;
    const tokenRes = await fetch(tokenUrl).then(r => r.json());
    if (tokenRes.errcode) throw new Error(tokenRes.errmsg);

    // 2. 用 access_token 获取用户信息
    const userUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenRes.access_token}&openid=${tokenRes.openid}`;
    const userRes = await fetch(userUrl).then(r => r.json());
    if (userRes.errcode) throw new Error(userRes.errmsg);

    // 3. 保存/更新用户
    const users = readJSON(USERS_FILE);
    let user = users.find(u => u.openid === userRes.openid);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        openid: userRes.openid,
        nickname: userRes.nickname,
        avatar: userRes.headimgurl,
        created_at: new Date().toISOString()
      };
      users.push(user);
    } else {
      user.nickname = userRes.nickname;
      user.avatar = userRes.headimgurl;
    }
    writeJSON(USERS_FILE, users);

    // 4. 生成 JWT
    const jwttoken = jwt.sign({ id: user.id, openid: user.openid, nickname: user.nickname, avatar: user.avatar }, JWT_SECRET, { expiresIn: '7d' });

    // 5. 重定向到前端，附带 token
    res.redirect(`${BASE_PATH}/?token=${jwttoken}`);
  } catch (e) {
    console.error('微信登录失败:', e.message);
    res.redirect(`${BASE_PATH}/?error=wechat_failed&msg=${encodeURIComponent(e.message)}`);
  }
});

// 开发模式模拟登录
app.post('/auth/dev-login', (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: '开发模式未启用' });
  const { nickname } = req.body;
  if (!nickname || !nickname.trim()) return res.status(400).json({ error: '请输入昵称' });

  const name = nickname.trim();
  const users = readJSON(USERS_FILE);
  let user = users.find(u => u.nickname === name);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      openid: 'dev_' + crypto.randomBytes(8).toString('hex'),
      nickname: name,
      avatar: '',
      created_at: new Date().toISOString()
    };
    users.push(user);
  }
  writeJSON(USERS_FILE, users);

  const jwttoken = jwt.sign({ id: user.id, openid: user.openid, nickname: user.nickname, avatar: user.avatar }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token: jwttoken, user: { nickname: user.nickname, avatar: user.avatar } });
});

// 获取当前会话
app.get('/auth/session', authRequired, (req, res) => {
  res.json({ user: req.user });
});

// 获取微信登录配置
app.get('/auth/config', (req, res) => {
  res.json({
    devMode: DEV_MODE,
    wechatEnabled: !!WECHAT_APPID,
    appid: WECHAT_APPID
  });
});

// ==================== 员工管理 API ====================
// 获取所有员工
app.get('/api/employees', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  const { department, search, sort } = req.query;
  let list = [...employees];

  if (department) list = list.filter(e => e.department === department);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(e => e.name.toLowerCase().includes(q) || e.position.toLowerCase().includes(q) || e.department.toLowerCase().includes(q));
  }
  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (sort === 'hire_date') list.sort((a, b) => new Date(b.hire_date) - new Date(a.hire_date));
  else if (sort === 'hire_date_asc') list.sort((a, b) => new Date(a.hire_date) - new Date(b.hire_date));
  else list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(list);
});

// 获取员工详情
app.get('/api/employees/:id', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  const emp = employees.find(e => e.id === req.params.id);
  if (!emp) return res.status(404).json({ error: '员工不存在' });
  res.json(emp);
});

// 新增员工
app.post('/api/employees', authRequired, (req, res) => {
  const { name, gender, birth_date, department, position, hire_date, strengths, weaknesses, previous_job, personality, remarks, employment_type } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: '姓名不能为空' });
  if (!department || !department.trim()) return res.status(400).json({ error: '部门不能为空' });

  const employee = {
    id: crypto.randomUUID(),
    name: name.trim(),
    gender: gender || '',
    birth_date: birth_date || '',
    department: department.trim(),
    position: position?.trim() || '',
    hire_date: hire_date || '',
    strengths: strengths?.trim() || '',
    weaknesses: weaknesses?.trim() || '',
    previous_job: previous_job?.trim() || '',
    personality: personality?.trim() || '',
    remarks: remarks?.trim() || '',
    employment_type: employment_type || '',
    created_by: req.user.nickname,
    created_by_id: req.user.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const employees = readJSON(EMPLOYEES_FILE);
  employees.push(employee);
  writeJSON(EMPLOYEES_FILE, employees);
  res.status(201).json(employee);
});

// 更新员工
app.put('/api/employees/:id', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  const idx = employees.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '员工不存在' });

  const fields = ['name', 'gender', 'birth_date', 'department', 'position', 'hire_date', 'strengths', 'weaknesses', 'previous_job', 'personality', 'remarks', 'employment_type'];
  for (const f of fields) {
    if (req.body[f] !== undefined) employees[idx][f] = req.body[f].trim?.() ?? req.body[f];
  }
  employees[idx].updated_at = new Date().toISOString();

  writeJSON(EMPLOYEES_FILE, employees);
  res.json(employees[idx]);
});

// 删除员工
app.delete('/api/employees/:id', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  const idx = employees.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '员工不存在' });
  const removed = employees.splice(idx, 1)[0];
  writeJSON(EMPLOYEES_FILE, employees);
  res.json({ success: true, name: removed.name });
});

// 获取部门列表
app.get('/api/departments', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();
  res.json(depts);
});

// 统计数据
app.get('/api/stats', authRequired, (req, res) => {
  const employees = readJSON(EMPLOYEES_FILE);
  let male = 0, female = 0, regular = 0, probation = 0;
  employees.forEach(e => {
    if (e.gender === '男') male++;
    else if (e.gender === '女') female++;
    if (e.employment_type === '已转正') regular++;
    else if (e.employment_type === '未转正') probation++;
  });
  res.json({
    total: employees.length,
    male, female, regular, probation
  });
});

// ==================== 启动 ====================
app.listen(PORT, () => {
  console.log(`\n  员工档案管理系统已启动: http://localhost:${PORT}${BASE_PATH}`);
  if (DEV_MODE) {
    console.log(`  模式: 开发模式（模拟微信登录）`);
  } else {
    console.log(`  模式: 微信OAuth登录`);
    console.log(`  微信AppID: ${WECHAT_APPID}`);
  }
  console.log();
});
