require('dotenv').config();
const mineflayer = require('mineflayer');
const Movements = require('mineflayer-pathfinder').Movements;
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const { GoalBlock, GoalNear } = require('mineflayer-pathfinder').goals;
const express = require('express');
const http = require('http');
const https = require('https');
const mcproto = require('minecraft-protocol');

function bool(val, def = false) {
  if (val === undefined) return def;
  return String(val).toLowerCase() === 'true';
}

function num(val, def) {
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

function csv(val, defArr = []) {
  if (!val) return defArr;
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

const config = {
  'bot-account': {
    username: process.env.BOT_USERNAME || 'DiasporaBot1',
    password: process.env.BOT_PASSWORD || '',
    type: process.env.BOT_AUTH || 'offline'
  },
  server: {
    ip: process.env.SERVER_IP || 'Diiasporiana.aternos.me',
    port: num(process.env.SERVER_PORT, 48941),
    version: process.env.SERVER_VERSION || '1.12.1',
    checkTimeoutMs: num(process.env.CHECK_TIMEOUT_MS, 90000)
  },
  position: {
    enabled: bool(process.env.POSITION_ENABLED, false),
    x: num(process.env.POSITION_X, 0),
    y: num(process.env.POSITION_Y, 0),
    z: num(process.env.POSITION_Z, 0)
  },
  utils: {
    'auto-auth': {
      enabled: bool(process.env.AUTO_AUTH_ENABLED, false),
      password: process.env.AUTO_AUTH_PASSWORD || ''
    },
    'anti-afk': {
      enabled: bool(process.env.ANTI_AFK_ENABLED, true),
      sneak: bool(process.env.ANTI_AFK_SNEAK, true)
    },
    'chat-messages': {
      enabled: bool(process.env.CHAT_MESSAGES_ENABLED, true),
      repeat: bool(process.env.CHAT_MESSAGES_REPEAT, true),
      'repeat-delay': num(process.env.CHAT_MESSAGES_REPEAT_DELAY, 6000),
      messages: csv(process.env.CHAT_MESSAGES, ['Я сто проц не бот.', 'Діяспоря кращий сервер', 'Пласт форевер'])
    },
    roam: {
      enabled: bool(process.env.ROAM_ENABLED, true),
      radius: num(process.env.ROAM_RADIUS, 8),
      interval: num(process.env.ROAM_INTERVAL, 30)
    },
    'chat-log': bool(process.env.CHAT_LOG, true),
    'auto-reconnect': bool(process.env.AUTO_RECONNECT, true),
    'auto-recconect-delay': num(process.env.AUTO_RECONNECT_DELAY_MS, 30000)
  }
};

const app = express();
app.get('/', (req, res) => {
  res.send('ok');
});
const SELF_PORT = Number(process.env.PORT) || 3000;
const server = app.listen(SELF_PORT, () => {
  console.log(`[Self-Ping] Listening on ${SELF_PORT}`);
});
const SELF_PING_URL = process.env.SELF_PING_URL || `http://localhost:${SELF_PORT}/`;
setInterval(() => {
  try {
    const urlObj = new URL(SELF_PING_URL);
    const client = urlObj.protocol === 'https:' ? https : http;
    client
      .get(SELF_PING_URL, (res) => {
        res.resume();
      })
      .on('error', (err) => {
        console.log(`[Self-Ping] error: ${err.message}`);
      });
  } catch (e) {
    console.log(`[Self-Ping] invalid URL: ${SELF_PING_URL} (${e.message})`);
  }
}, 120000);

// Username rotation state
let baseUsername = config['bot-account']['username'];
let usernameCounter = 0;
let currentUsername = baseUsername;
let reconnectAttempts = 0;
let botInstance = null; // Track the active bot instance
let msgTimer = null;    // Interval for chat messages
let roamTimer = null;   // Interval for roaming

function nextUsername() {
  
  return `${baseUsername}`;
}

 

function createBot() {
   if (botInstance) {
      console.log('[AfkBot] Bot already running; createBot skipped');
      return;
   }

   const bot = mineflayer.createBot({
      username: currentUsername,
      password: config['bot-account']['password'],
      auth: config['bot-account']['type'],
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version,
      checkTimeoutInterval: config.server.checkTimeoutMs
   });

   botInstance = bot;

   // Ensure EventEmitter method keeps correct `this` when captured unbound by plugins
   if (bot && typeof bot.removeAllListeners === 'function') {
      bot.removeAllListeners = bot.removeAllListeners.bind(bot);
   }

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
      reconnectAttempts = 0;

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

            msgTimer = setInterval(() => {
               // Guard against sending on closed socket which can cause EPIPE
               if (!bot._client || !bot._client.socket || bot._client.socket.destroyed) return;
               try { bot.chat(`${messages[i]}`); } catch (_) {}

               if (i + 1 === messages.length) {
                  i = 0;
               } else {
                  i++;
               }
            }, delay * 1000);
         } else {
            messages.forEach((msg) => {
               try { bot.chat(msg); } catch (_) {}
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
         roamTimer = setInterval(() => {
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
         // Prepare a new username ONLY for duplicate login cases
         const oldUsername = currentUsername;
         currentUsername = nextUsername();
         console.log(`\x1b[36m[AfkBot] Next reconnect will use username: "${currentUsername}" (previous: "${oldUsername}")\x1b[0m`);
      }
   });

   if (config.utils['auto-reconnect']) {
      bot.on('end', (reason) => {
         const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
         if (reasonStr && reasonStr.includes('duplicate_login')) {
            console.log('\x1b[31m[INFO] Not reconnecting due to duplicate login.\x1b[0m');
            return;
         }
         // Clear intervals to avoid writing to a closed socket (prevents EPIPE)
         if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
         if (roamTimer) { clearInterval(roamTimer); roamTimer = null; }
         botInstance = null;
         const baseDelay = config.utils['auto-recconect-delay'] || 5000;
         let delay = baseDelay;
         if (reasonStr && /throttled/i.test(reasonStr)) {
            delay = Math.max(baseDelay, 60000);
         } else {
            reconnectAttempts += 1;
            delay = Math.min(300000, Math.floor(baseDelay * Math.pow(2, Math.max(0, reconnectAttempts - 1))));
         }
         delay += Math.floor(Math.random() * 3000);
         console.log(`\x1b[33m[AfkBot] Reconnecting in ${Math.round(delay/1000)}s (reason: ${reasonStr || 'unknown'})\x1b[0m`);
         setTimeout(() => {
            createBot();
         }, delay);
      });
   }

   bot.on('error', (err) =>
      console.log(`\x1b[31m[ERROR] ${err.message}`, '\x1b[0m')
   );
}

// Periodically check if the server is empty and, if so, start the keep-alive bot
const SERVER_CHECK_INTERVAL_MS = Number(process.env.SERVER_CHECK_INTERVAL_MS) || 60000;
async function isServerEmpty() {
  return new Promise((resolve) => {
    mcproto.ping(
      { host: config.server.ip, port: config.server.port, version: config.server.version },
      (err, res) => {
        if (err) {
          console.log(`[ServerCheck] ping error: ${err.message}`);
          return resolve(false);
        }
        const online = (res && res.players && typeof res.players.online === 'number') ? res.players.online : 0;
        resolve(online === 0);
      }
    );
  });
}

setInterval(async () => {
  try {
    const empty = await isServerEmpty();
    if (empty && !botInstance) {
      console.log('[ServerCheck] Server empty. Spawning keep-alive bot...');
      createBot();
    }
  } catch (e) {
    console.log(`[ServerCheck] error: ${e.message}`);
  }
}, SERVER_CHECK_INTERVAL_MS);

createBot();
