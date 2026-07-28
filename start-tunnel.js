// 一键启动：服务器 + 公网隧道
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3001;
const serverScript = path.join(__dirname, 'server.js');

// 1. 启动服务器
console.log('启动服务器...');
const server = spawn(process.execPath, [serverScript, '--dev'], {
  cwd: __dirname,
  env: { ...process.env, NODE_PATH: path.join(__dirname, 'node_modules') },
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stderr.on('data', (d) => {
  const msg = d.toString();
  if (!msg.includes('已启动')) process.stderr.write(msg);
});

// 2. 等服务器启动后开隧道
setTimeout(() => {
  console.log('启动公网隧道...');
  const lt = require('localtunnel');
  (async () => {
    try {
      const tunnel = await lt({ port: PORT });
      console.log('\n============================================');
      console.log('  公网地址 (分享给其他人):');
      console.log(`  ${tunnel.url}/hemingshangmaokuajingdianrenyuanguilei/`);
      console.log('============================================');
      console.log('\n本窗口关闭后，其他人将无法访问。');
      console.log('按 Ctrl+C 可停止服务。\n');

      tunnel.on('error', (err) => {
        console.log('隧道错误: ' + err.message);
      });
      tunnel.on('close', () => {
        console.log('隧道已关闭');
      });
    } catch (e) {
      console.log('隧道启动失败: ' + e.message);
      console.log('\n但局域网内仍可通过以下地址访问:');
      console.log(`  http://当前电脑IP:${PORT}/hemingshangmaokuajingdianrenyuanguilei/`);
    }
  })();
}, 3000);

// 保持运行
process.on('SIGINT', () => {
  console.log('\n正在关闭...');
  server.kill();
  process.exit(0);
});
