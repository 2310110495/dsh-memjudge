// 测试用宿主桩：模拟 ctx.connection.fetch.register 的 exact 路由登记。
//
// 为什么需要它：host 侧 rpc.mjs 已从旧式前缀通道迁到 connection.fetch.register，
// 测试不能再靠「截获一个 handler 函数」来调用端点；必须走一遍真实的
// register -> Request -> Response 路径，才能保证 path/methods/requestBody
// 与连接层的约定（assertFetchRoute、requestBodyMode）一致。
//
// call(endpoint, payload) 返回解析后的 JSON 对象，形状与旧 handler 的返回值完全相同。

export function stubConnection() {
  const routes = new Map();
  const connection = {
    fetch: {
      register(route) {
        // 与真实连接层 registerFetchRoute 的重复注册行为保持一致，幂等保护才有意义。
        if (routes.has(route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
        }
        routes.set(route.path, route);
        return () => {
          routes.delete(route.path);
        };
      },
    },
  };
  const call = async (endpoint, payload) => {
    const path = `/api/memjudge.${endpoint}`;
    const route = routes.get(path);
    if (!route) throw new Error(`未注册的 Fetch 路由：${path}`);
    const request = new Request(`http://dsh.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    return (await route.fetch(request)).json();
  };
  return { connection, routes, call };
}
