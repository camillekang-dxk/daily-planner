// 从环境变量读取 Upstash Redis 配置
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 导出 Edge Function 配置
export const config = {
  runtime: 'edge'
};

// Redis 命令执行
async function redisCommand(command, ...args) {
  const encodedArgs = args.map(arg => {
    return encodeURIComponent(arg);
  });

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

export default async function handler(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // CORS 处理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  // 检查环境变量是否配置
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({
      error: '数据库未配置',
      message: '请在 Vercel 环境变量中设置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN'
    }), {
      status: 500,
      headers
    });
  }

  try {
    // 获取认证信息
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: '需要认证' }), {
        status: 401,
        headers
      });
    }

    const password = authHeader.replace('Bearer ', '');
    if (!password) {
      return new Response(JSON.stringify({ error: '密码不能为空' }), {
        status: 401,
        headers
      });
    }

    const userKey = `todos:${password}`;

    // GET /api/todos - 获取待办
    if (pathname === '/api/todos' && request.method === 'GET') {
      try {
        const result = await redisCommand('GET', userKey);
        const todos = result.result ? JSON.parse(result.result) : {};
        return new Response(JSON.stringify({ success: true, data: todos }), {
          status: 200,
          headers
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers
        });
      }
    }

    // POST /api/todos - 保存所有待办
    if (pathname === '/api/todos' && request.method === 'POST') {
      const body = await request.json();
      const { todos } = body;

      await redisCommand('SET', userKey, JSON.stringify(todos));

      return new Response(JSON.stringify({ success: true, message: '保存成功' }), {
        status: 200,
        headers
      });
    }

    // PUT /api/todos/sync - 同步（合并本地和云端）
    if (pathname === '/api/todos/sync' && request.method === 'PUT') {
      const body = await request.json();
      const { localTodos } = body;

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

      return new Response(JSON.stringify({
        success: true,
        data: merged,
        syncTime: Date.now()
      }), {
        status: 200,
        headers
      });
    }

    return new Response(JSON.stringify({ error: '接口不存在' }), {
      status: 404,
      headers
    });

  } catch (error) {
    console.error('API Error:', error);
    return new Response(JSON.stringify({
      error: '服务器错误',
      message: error.message
    }), {
      status: 500,
      headers
    });
  }
}

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
