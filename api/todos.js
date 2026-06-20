import { kv } from '@vercel/kv';

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
      const todos = await kv.get(userKey) || {};
      return new Response(JSON.stringify({ success: true, data: todos }), {
        status: 200,
        headers
      });
    }

    // POST /api/todos - 保存所有待办
    if (pathname === '/api/todos' && request.method === 'POST') {
      const body = await request.json();
      const { todos } = body;
      await kv.set(userKey, todos);
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
      const cloudTodos = await kv.get(userKey) || {};

      // 合并策略：按更新时间取最新
      const merged = mergeTodos(localTodos, cloudTodos);

      // 保存合并后的数据
      await kv.set(userKey, merged);

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
  const allDates = new Set([...Object.keys(local), ...Object.keys(cloud)]);

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
