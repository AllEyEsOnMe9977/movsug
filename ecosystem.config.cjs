module.exports = {
  apps: [
    {
      name: "fansy-movie-bot",
      script: "./src/index.js",
      
      // Prevent PM2 from restarting the bot every time movies.db updates
      watch: false,
      
      // Automatically restart if the bot crashes
      autorestart: true,
      
      // Delay between automatic restarts (prevents spamming Telegram API if something breaks)
      max_restarts: 10,
      restart_delay: 5000,
      
      // Combine error and standard output logs
      merge_logs: true,
      
      // Pass environment variables
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};