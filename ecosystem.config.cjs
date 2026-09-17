module.exports = {
  apps: [
    {
      name: 'wkbdy-api',
      cwd: __dirname,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 16000,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
