const path = require('path');

module.exports = {
  apps: [
    {
      name: 'nonoka',
      script: path.join(__dirname, 'src/index.ts'),
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,

      // 进程守护
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',          // 启动后存活不到 10s 视为启动失败
      restart_delay: 3000,        // 崩溃后等 3s 再拉起
      watch: false,               // 不监听文件变动自动重启

      env: {
        NODE_ENV: 'production',
      },

      // 日志
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/error.log'),
      merge_logs: true,
    },
    {
      // 日志网页服务：tail 上面的日志文件，用浏览器实时查看
      name: 'nonoka-log',
      script: path.join(__dirname, 'scripts/log-server.cjs'),
      cwd: __dirname,
      autorestart: true,
      env: {
        LOG_PORT: 9615,
        LOG_HOST: '0.0.0.0',
        LOG_TOKEN: 'nonoka233',
      },
    },
  ],
};
