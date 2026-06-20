// Vercel Serverless Function
// 从环境变量读取 Upstash Redis 配置
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Redis 命令执行
async function redisCommand(command, ...args) {
  const encodedArgs = args.map(arg => encodeURIComponent(arg));

  const response = await fetch(`${UPSTASH_URL}/${command}/${encodedArgs.join('/')}`, {
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`Redis error: ${response.status}`);
  }

  return await response.json();
}

// Vercel Serverless Function handler
module.exports = async (req, res) => {
  const pathname = req.url;

  // CORS 处理
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(200).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 检查环境变量是否配置
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({
      error: '数据库未配置',
      message: '请在 Vercel 环境变量中设置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN'
    });
    return;
  }

  try {
    // 获取认证信息
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: '需要认证' });
      return;
    }

    const password = authHeader.replace('Bearer ', '');
    if (!password) {
      res.status(401).json({ error: '密码不能为空' });
      return;
    }

    const userKey = `todos:${password}`;

    // GET /api/todos - 获取待办
    if (pathname === '/api/todos' && req.method === 'GET') {
      try {
        const result = await redisCommand('GET', userKey);
        const todos = result.result ? JSON.parse(result.result) : {};
        res.status(200).json({ success: true, data: todos });
      } catch (e) {
        res.status(200).json({ success: true, data: {} });
      }
      return;
    }

    // POST /api/todos - 保存所有待办
    if (pathname === '/api/todos' && req.method === 'POST') {
      const { todos } = req.body;
      await redisCommand('SET', userKey, JSON.stringify(todos));
      res.status(200).json({ success: true, message: '保存成功' });
      return;
    }

    // PUT /api/todos/sync - 同步（合并本地和云端）
    if (pathname === '/api/todos/sync' && req.method === 'PUT') {
      const { localTodos } = req.body;

      // 获取云端数据
      let cloudTodos = {};
      try {
        const result = await redisCommand('GET', userKey);
        if (result.result) {
          cloudTodos = JSON.parse(result.result);
        }
      } catch (e) {
        cloudTodos = {};
      }

      // 合并策略：按更新时间取最新
      const merged = mergeTodos(localTodos, cloudTodos);

      // 保存合并后的数据
      await redisCommand('SET', userKey, JSON.stringify(merged));

      res.status(200).json({
        success: true,
        data: merged,
        syncTime: Date.now()
      });
      return;
    }

    res.status(404).json({ error: '接口不存在' });

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: '服务器错误',
      message: error.message
    });
  }
};

// 合并待办：简单的最后写入优先
function mergeTodos(local, cloud) {
  const merged = {};
  const allDates = new Set([...Object.keys(local || {}), ...Object.keys(cloud || {})]);

  for (const date of allDates) {
    const localList = local[date] || [];
    const cloudList = cloud[date] || [];

    // 按 ID 合并，以更新时间较新的为准
    const todoMap = new Map();

    for (const todo of localList) {
      todoMap.set(todo.id, { ...todo });
    }

    for (const todo of cloudList) {
      const existing = todoMap.get(todo.id);
      if (!existing) {
        todoMap.set(todo.id, { ...todo });
      }
      // 如果有相同的 ID，保留更新时间较新的
      else if (todo.updatedAt && existing.updatedAt) {
        if (new Date(todo.updatedAt) > new Date(existing.updatedAt)) {
          todoMap.set(todo.id, { ...todo });
        }
      }
    }

    merged[date] = Array.from(todoMap.values());
  }

  return merged;
}
