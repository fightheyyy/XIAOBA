// Electron子进程：启动dashboard HTTP server
const path = require('path');

// 设置工作目录为项目根目录
process.chdir(path.join(__dirname, '..', '..'));

// 加载dotenv；Electron Dashboard 使用当前工作目录下的 .env 作为运行时配置源。
const envPath = path.join(process.cwd(), '.env');
process.env.DOTENV_CONFIG_PATH = envPath;
process.env.DOTENV_CONFIG_OVERRIDE = 'true';
require('dotenv').config({ path: envPath, quiet: true, override: true });

const { startDashboard } = require('../../dist/surfaces/dashboard/server');

const port = parseInt(process.env.DASHBOARD_PORT || '3800', 10);

startDashboard(port).then(() => {
  // 通知主进程server已就绪
  if (process.send) {
    process.send('ready');
  }
});
