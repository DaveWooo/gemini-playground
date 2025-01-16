import { serve } from "https://deno.land/std@0.204.0/http/server.ts";

function getContentType(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const types = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
}

async function handleWebSocket(request) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket connection", { status: 400 });
  }

  const url = new URL(request.url);
  const pathAndQuery = url.pathname + url.search;
  const targetUrl = `wss://generativelanguage.googleapis.com${pathAndQuery}`;
  
  console.log('Target URL:', targetUrl);
  
  const { socket: clientWs, response } = Deno.upgradeWebSocket(request);
  
  const targetWs = new WebSocket(targetUrl);
  const pendingMessages = [];

  targetWs.onopen = () => {
    console.log('Connected to Gemini');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = () => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
  };

  targetWs.onclose = () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  };

  return response;
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    console.log('Request URL:', url.pathname);

    // 处理 WebSocket 连接
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request);
    }

    // 处理静态资源
    let path = url.pathname;
    if (path === '/' || path === '') {
      path = '/index.html';
    }

    // 尝试读取文件
    try {
      const filePath = `${Deno.cwd()}/src/static${path}`;
      const content = await Deno.readFile(filePath);
      return new Response(content, {
        headers: {
          'content-type': `${getContentType(path)};charset=UTF-8`,
          'cache-control': 'public, max-age=3600'
        },
      });
    } catch (error) {
      console.error('File read error:', error);
      return new Response('Not Found', { 
        status: 404,
        headers: { 'content-type': 'text/plain;charset=UTF-8' }
      });
    }
  } catch (error) {
    console.error('Request handling error:', error);
    return new Response('Internal Server Error', { 
      status: 500,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }
    });
  }
}

console.log("Starting server...");
await serve(handleRequest, { port: 8000 });