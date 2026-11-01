// pm2 ecosystem for Boorushiko.
//
//   (cd server && npm ci && npm run build)   # dist/index.js must exist
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//
// The wrapper adds `nice`/`ionice` so this site cannot starve the neighbours on
// the shared box; NODE_ENV=production is what enables Secure cookies, the
// default loopback proxy trust and automatic source imports.
module.exports = {
  apps: [
    {
      name: 'boorushiko',
      cwd: __dirname,
      script: './run.sh',
      interpreter: 'bash',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      kill_timeout: 10000,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
