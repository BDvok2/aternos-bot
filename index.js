const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals;

const config = require('./settings.json');
const express = require('express');
const http = require('http');

const app = express();
const PORT = 5000;

// Username rotation state
let baseUsername = config['bot-account']['username'];
let usernameCounter = 0;
let currentUsername = baseUsername;

function nextUsername() {
  usernameCounter += 1;
  return `${baseUsername}${usernameCounter}`;
}

app.get('/', (req, res) => {
  res.send('Bot is running and staying alive!');
});

app.get('/ping', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  res.json({
    status: 'alive',
    message: 'Bot is running',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    timestamp: new Date().toISOString()
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
  
  const replitUrl = process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : `http://localhost:${PORT}`;
  
  console.log('\n==============================================');
  console.log('🔗 KEEP-ALIVE URLs:');
  console.log(`   Main: ${replitUrl}`);
  console.log(`   Ping API: ${replitUrl}/ping`);
  console.log('==============================================');
  console.log('ℹ️  To keep this bot alive, ping one of the URLs');
  console.log('   above using an external service like:');
  console.log('   • UptimeRobot');
  console.log('   • Cron-Job.org');
  console.log('   • BetterUptime');
  console.log('   Set interval: every 5 minutes');
  console.log('==============================================\n');
  
  setInterval(() => {
    http.get(`http://localhost:${PORT}`, (res) => {
      console.log(`[Keep-Alive] Self-ping successful - Status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[Keep-Alive] Self-ping failed:', err.message);
    });
  }, 5 * 60 * 1000);
});

function createBot() {
   const bot = mineflayer.createBot({
      username: currentUsername,
      password: config['bot-account']['password'],
      auth: config['bot-account']['type'],
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
   });

   bot.loadPlugin(pathfinder);
   const mcData = require('minecraft-data')(bot.version);
   const defaultMove = new Movements(bot, mcData);
   if (bot.settings && typeof bot.settings.colorsEnabled !== 'undefined') {
      bot.settings.colorsEnabled = false;
   }

   let pendingPromise = Promise.resolve();

   function sendRegister(password) {
      return new Promise((resolve, reject) => {
         bot.chat(`/register ${password} ${password}`);
         console.log(`[Auth] Sent /register command.`);

         bot.once('chat', (username, message) => {
            console.log(`[ChatLog] <${username}> ${message}`); // Log all chat messages

            // Check for various possible responses
            if (message.includes('successfully registered')) {
               console.log('[INFO] Registration confirmed.');
               resolve();
            } else if (message.includes('already registered')) {
               console.log('[INFO] Bot was already registered.');
               resolve(); // Resolve if already registered
            } else if (message.includes('Invalid command')) {
               reject(`Registration failed: Invalid command. Message: "${message}"`);
            } else {
               reject(`Registration failed: unexpected message "${message}".`);
            }
         });
      });
   }

   function sendLogin(password) {
      return new Promise((resolve, reject) => {
         bot.chat(`/login ${password}`);
         console.log(`[Auth] Sent /login command.`);

         bot.once('chat', (username, message) => {
            console.log(`[ChatLog] <${username}> ${message}`); // Log all chat messages

            if (message.includes('successfully logged in')) {
               console.log('[INFO] Login successful.');
               resolve();
            } else if (message.includes('Invalid password')) {
               reject(`Login failed: Invalid password. Message: "${message}"`);
            } else if (message.includes('not registered')) {
               reject(`Login failed: Not registered. Message: "${message}"`);
            } else {
               reject(`Login failed: unexpected message "${message}".`);
            }
         });
      });
   }

   bot.once('spawn', () => {
      console.log('\x1b[33m[AfkBot] Bot joined the server', '\x1b[0m');

      if (config.utils['auto-auth'].enabled) {
         console.log('[INFO] Started auto-auth module');

         const password = config.utils['auto-auth'].password;

         pendingPromise = pendingPromise
            .then(() => sendRegister(password))
            .then(() => sendLogin(password))
            .catch(error => console.error('[ERROR]', error));
      }

      if (config.utils['chat-messages'].enabled) {
         console.log('[INFO] Started chat-messages module');
         const messages = config.utils['chat-messages']['messages'];

         if (config.utils['chat-messages'].repeat) {
            const delay = config.utils['chat-messages']['repeat-delay'];
            let i = 0;

            let msg_timer = setInterval(() => {
               bot.chat(`${messages[i]}`);

               if (i + 1 === messages.length) {
                  i = 0;
               } else {
                  i++;
               }
            }, delay * 1000);
         } else {
            messages.forEach((msg) => {
               bot.chat(msg);
            });
         }
      }

      const pos = config.position;

      if (config.position.enabled) {
         console.log(
            `\x1b[32m[Afk Bot] Starting to move to target location (${pos.x}, ${pos.y}, ${pos.z})\x1b[0m`
         );
         bot.pathfinder.setMovements(defaultMove);
         bot.pathfinder.setGoal(new GoalBlock(pos.x, pos.y, pos.z));
      }

      // Roam around randomly if enabled and no fixed position goal is set
      const roamCfg = (config.utils && config.utils['roam']) ? config.utils['roam'] : { enabled: false };
      if (!config.position.enabled && roamCfg.enabled) {
         console.log('[INFO] Started roam module');
         const radius = roamCfg.radius || 8;
         const interval = roamCfg.interval || 30; // seconds
         setInterval(() => {
            const p = bot.entity.position;
            const tx = Math.round(p.x) + Math.floor((Math.random() * 2 - 1) * radius);
            const tz = Math.round(p.z) + Math.floor((Math.random() * 2 - 1) * radius);
            const ty = Math.round(p.y);
            bot.pathfinder.setMovements(defaultMove);
            bot.pathfinder.setGoal(new GoalNear(tx, ty, tz, 1));
         }, interval * 1000);
      }

      if (config.utils['anti-afk'].enabled) {
         bot.setControlState('jump', true);
         if (config.utils['anti-afk'].sneak) {
            bot.setControlState('sneak', true);
         }
      }
   });

   bot.on('goal_reached', () => {
      console.log(
         `\x1b[32m[AfkBot] Bot arrived at the target location. ${bot.entity.position}\x1b[0m`
      );
   });

   bot.on('death', () => {
      console.log(
         `\x1b[33m[AfkBot] Bot has died and was respawned at ${bot.entity.position}`,
         '\x1b[0m'
      );
   });

   bot.on('kicked', (reason) => {
      console.log(
         '\x1b[33m',
         `[AfkBot] Bot was kicked from the server. Reason: \n${reason}`,
         '\x1b[0m'
      );
      
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
      if (reasonStr.includes('duplicate_login')) {
         console.log('\x1b[31m[ERROR] Duplicate login detected! Another instance is already logged in with this username.\x1b[0m');
         console.log('\x1b[31m[ERROR] Please log out from the server or stop the other bot instance before reconnecting.\x1b[0m');
         console.log('\x1b[31m[ERROR] Auto-reconnect disabled for this session.\x1b[0m');
         bot.removeAllListeners('end');
      }

      // Prepare a new username for the next reconnect attempt
      const oldUsername = currentUsername;
      currentUsername = nextUsername();
      console.log(`\x1b[36m[AfkBot] Next reconnect will use username: "${currentUsername}" (previous: "${oldUsername}")\x1b[0m`);
   });

   if (config.utils['auto-reconnect']) {
      bot.on('end', (reason) => {
         const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
         if (reasonStr && reasonStr.includes('duplicate_login')) {
            console.log('\x1b[31m[INFO] Not reconnecting due to duplicate login.\x1b[0m');
            return;
         }
         
         setTimeout(() => {
            createBot();
         }, config.utils['auto-recconect-delay']);
      });
   }

   bot.on('error', (err) =>
      console.log(`\x1b[31m[ERROR] ${err.message}`, '\x1b[0m')
   );
}

createBot();
