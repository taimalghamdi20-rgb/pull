const fs = require('fs');
const path = require('path');
const express = require('express');

// ===== سيرفر Express =====
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.get('/', (req, res) => res.send('✅ البوت شغال.'));

// ===== حماية =====
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err);
});

const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  AuditLogEvent,
  PermissionFlagsBits,
} = require('discord.js');

// ===== قاعدة بيانات =====
const Database = require('better-sqlite3');
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS active_leaves (
    user_id TEXT PRIMARY KEY,
    end_date INTEGER
  );
  CREATE TABLE IF NOT EXISTS evaluated_sessions (
    session_id TEXT PRIMARY KEY
  );
`);

// ===== متغيرات البيئة =====
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== رومات الانتظار والإدارة =====
const ADDITIONAL_WAITING_IDS = [
  '1481398869463138604',
  '1519511668823167116',
  '1483285123008041031'
];

const WAITING_CHANNEL_IDS = [
  ...WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean),
  ...ADDITIONAL_WAITING_IDS
];

const WAITING_ROOM_ADMIN_MAP = {
  '1519511668823167116': [
    '1531980761039638618',
    '1531980726134636574',
    '1531980042031075388',
    '1531982552863215676'
  ],
  '1481398869463138604': [
    '1538018549581217913',
    '1538019707960037507',
    '1538019743217352765',
    '1538019769674899456',
    '1538019791334408304'
  ],
  '1483285123008041031': [
    '1499460333214109957',
    '1499460308262060032',
    '1499168130910388244',
    '1499168095561056366',
    '1493989690766921768',
    '1483283498419884145',
    '1483283430379618424',
    '1483283321789222933',
    '1483283249416638514',
    '1483283170265665566'
  ]
};

const WAITING_ROOM_REQUIRED_ROLE = {
  '1483285123008041031': '1486587636863864862'
};

const SPECIAL_ROLE_ID = '1476796533168017428';
const SPECIAL_WAITING_ROOM_ID = '1519511668823167116';
const SPECIAL_ADMIN_ROOM_IDS = [
  '1499105265272754246',
  '1499105221383819497',
  '1499105170716491806',
  '1525972362246226041',
  '1499105092933128212',
  '1499084679083720805',
  '1499352796435058848',
  '1499352980120403989',
  '1499353050907938916',
  '1533115980241305860',
  '1535799453418782800',
  '1535799489837670520',
  '1535799510016589904'
];
const SPECIAL_REQUIRED_ADMIN_ROLE_ID = '1499102575918579793';

// ===== إعدادات عامة =====
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const LEAVE_REQUEST_MENTION_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const WAITING_NOTIFICATION_CHANNEL_ID = '1536740110966726656';
const WAITING_MENTION_ROLE_ID = '1499102575918579793';
const WAITING_TIMEOUT_MS = 3 * 60 * 1000;

const CUSTOM_WAITING_ROOM_ID = '1483285123008041031';
const CUSTOM_NOTIFICATION_CHANNEL_ID = '1536786125052444864';
const CUSTOM_MENTION_ROLE_ID = '1486587636863864862';
const CUSTOM_WAITING_TIMEOUT_MS = 2 * 60 * 1000;

const ADMIN_ROOM_IDS = [
  '1499105265272754246',
  '1499105221383819497',
  '1499105170716491806',
  '1525972362246226041',
  '1499105092933128212',
  '1499084679083720805',
  '1499352796435058848',
  '1499352980120403989',
  '1499353050907938916',
  '1499352946301730899',
  '1519516030899191809',
  '1519516058682130632',
];

const RATING_CHANNEL_ID = '1531018869764788446';
const DONE_VOICE_CHANNEL_ID = '1499086608010449089';
const BARREN_ROLE_ID = '1486588170282733700';

const PROMOTION_CHANNEL_ID = '1459305425857155308';
const SUPPORT_ROLE_ID = '1499162553245499432';
const SUPPORT_ROLE_LOG_CHANNEL_ID = '1459305788374782164';
const HOURS_LOG_CHANNEL_ID = '1513231005815931000';

const HM_PANEL_CHANNEL_ID = '1534312045166592171';
const HM_LOG_CHANNEL_ID = '1534313854329159710';
const HM_BANNER_PATH = path.join(__dirname, 'hm_banner.png');
const HM_BANNER_FILENAME = 'hm_banner.png';
const HM_IN_COLOR = 0x0b5e2e;
const HM_OUT_COLOR = 0x7b241c;

const HM_REQUIRED_VOICE_CHANNEL_IDS = [
  '1534308507611041842',
  '1534308470331805767',
  '1520491813310562536'
];
const HM_AUTO_OUT_TIMEOUT_MS = 60 * 1000;

const hmCheckedIn = new Map();
const hmLeaveTimers = new Map();

// ===== إعدادات الجرد المدمج =====
const INVENTORY_TARGET_ROLE_ID = '1459304465458008196';
const ACTIVATION_CHANNEL_ID = '1484859915200626829';
const REJECTION_CHANNEL_ID = '1484865429158756494';
const REACTIVATION_CHANNEL_ID = '1493565275428225125';
const HOURS_CHANNEL_IDS = ['1513220016718217228', '1513231005815931000'];
const DONE_CHANNEL_ID = '1529933848144510976';

// ترتيب الرتب (من الأعلى إلى الأسفل) - تم تحديثه
const ROLE_ORDER = [
  '1499162553245499432',
  '1539600368919515207',
  '1539600481490313346',
  '1480102405931667467',
  '1472332996269838490',
  '1472333499221544981',
  '1472333861965791374',
  '1472342890058354801', // تم إضافتها
  '1539598264708505620',
  '1539598177370509462',
  '1539598187986165811',
  '1480102742851850302',
  '1539601944652550144',
  '1539601925979508806',
  '1472353378695778537',
  '1459304443844497633',
  '1472352421153083563',
  '1459304436491882742'
];

// الرتب التي تعتمد على آخر ترقية (الخمس الأخيرة في ROLE_ORDER)
const PROMOTION_BASED_ROLES = ROLE_ORDER.slice(-5);

// ===== دوال مساعدة للجرد =====
async function getLatestMessagePerUser(channel, userIds) {
  const result = new Map();
  let lastId = null;
  let fetched = 0;
  const limit = 1000;
  const remaining = new Set(userIds);
  while (fetched < limit && remaining.size > 0) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;
    for (const [, msg] of msgs) {
      if (remaining.has(msg.author.id) && !result.has(msg.author.id)) {
        result.set(msg.author.id, msg);
        remaining.delete(msg.author.id);
      }
    }
    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }
  return result;
}

async function getLatestEmbedFieldPerUser(channel, userIds, fieldName) {
  const result = new Map();
  let lastId = null;
  let fetched = 0;
  const limit = 1000;
  const remaining = new Set(userIds);
  while (fetched < limit && remaining.size > 0) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;
    for (const [, msg] of msgs) {
      if (remaining.has(msg.author.id) && !result.has(msg.author.id)) {
        if (msg.embeds && msg.embeds.length > 0) {
          for (const embed of msg.embeds) {
            if (embed.fields) {
              const field = embed.fields.find(f => f.name && f.name.includes(fieldName));
              if (field) {
                result.set(msg.author.id, field.value);
                remaining.delete(msg.author.id);
                break;
              }
            }
          }
        }
      }
    }
    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }
  return result;
}

// ============================================================
// دوال مساعدة رئيسية (الإجازات، الجرد، إلخ)
// ============================================================

function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

function hasBarrenRole(member) {
  return member.roles.cache.has(BARREN_ROLE_ID);
}

// ===== دوال قاعدة البيانات =====
function loadActiveLeaves() {
  const stmt = db.prepare('SELECT user_id, end_date FROM active_leaves');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.user_id, { endDate: row.end_date });
  return map;
}

function saveActiveLeaves() {
  db.prepare('DELETE FROM active_leaves').run();
  const insert = db.prepare('INSERT INTO active_leaves (user_id, end_date) VALUES (?, ?)');
  const trans = db.transaction((entries) => {
    for (const [userId, data] of entries) insert.run(userId, data.endDate);
  });
  trans(activeLeaves.entries());
}

function isSessionEvaluated(sessionId) {
  const stmt = db.prepare('SELECT session_id FROM evaluated_sessions WHERE session_id = ?');
  return stmt.get(sessionId) !== undefined;
}

function markSessionEvaluated(sessionId) {
  const stmt = db.prepare('INSERT OR IGNORE INTO evaluated_sessions (session_id) VALUES (?)');
  stmt.run(sessionId);
}

const activeLeaves = loadActiveLeaves();

const MAX_LEAVE_DAYS = 14;
const LEAVE_PANEL_COLOR = 0xC2410C;
const LEAVE_BANNER_PATH = path.join(__dirname, 'leave_banner.png');
const LEAVE_BANNER_FILENAME = 'leave_banner.png';
const SERVER_LOGO_PATH = path.join(__dirname, 'server_logo.png');
const SERVER_LOGO_FILENAME = 'server_logo.png';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const activeSessions = new Map();
const cooldownMap = new Map();
const waitingTimers = new Map();
const customWaitingTimers = new Map();

// ============================================================
// دوال التقييم
// ============================================================
function ratingStarsBar(rating) {
  const filled = '⭐'.repeat(rating);
  const empty = '☆'.repeat(5 - rating);
  return filled + empty;
}

function ratingColor(rating) {
  if (rating >= 4) return 0x2ecc71;
  if (rating >= 2) return 0xf1a10c;
  return 0xed4245;
}

function ratingLabel(rating) {
  const labels = { 1: 'ضعيف جدًا', 2: 'ضعيف', 3: 'متوسط', 4: 'جيد', 5: 'ممتاز' };
  return labels[rating] || '';
}

// ============================================================
// دوال جلب الإحصائيات (لأمر barren)
// ============================================================
// دالة لجلب جميع الرسائل من قناة (بدون فلترة زمنية) ولكن بحد أقصى 5000
async function fetchAllMessages(channelId) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return [];
    const messages = [];
    let lastId = null;
    let fetched = 0;
    const limit = 5000;
    while (fetched < limit) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const msgs = await channel.messages.fetch(options);
      if (msgs.size === 0) break;
      messages.push(...msgs.values());
      lastId = msgs.last().id;
      fetched += msgs.size;
      if (msgs.size < 100) break;
    }
    return messages;
  } catch (err) {
    console.error(`❌ فشل جلب رسائل القناة ${channelId}:`, err);
    return [];
  }
}

async function fetchMessagesFromDate(channelId, fromDate) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return [];
    const limit = 1000;
    const messages = [];
    let lastId = null;
    let fetched = 0;
    while (fetched < limit) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const msgs = await channel.messages.fetch(options);
      if (msgs.size === 0) break;
      const filtered = msgs.filter(m => m.createdTimestamp >= fromDate);
      messages.push(...filtered.values());
      lastId = msgs.last().id;
      fetched += msgs.size;
      if (filtered.size < msgs.size) break;
    }
    return messages;
  } catch (err) {
    console.error(`❌ فشل جلب رسائل القناة ${channelId}:`, err);
    return [];
  }
}

async function getLastPromotionDate(guild) {
  const promotionChannel = client.channels.cache.get(PROMOTION_CHANNEL_ID);
  if (!promotionChannel) {
    console.error('❌ قناة الترقيات غير موجودة!');
    return new Map();
  }

  const lastPromotionMap = new Map();
  let lastId = null;
  let fetched = 0;
  const limit = 1000;
  while (fetched < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await promotionChannel.messages.fetch(options);
    if (msgs.size === 0) break;
    for (const [, msg] of msgs) {
      const match = msg.content.match(/<@!?(\d+)>/);
      if (match) {
        const userId = match[1];
        if (!lastPromotionMap.has(userId)) {
          lastPromotionMap.set(userId, msg.createdTimestamp);
        }
      }
    }
    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  return lastPromotionMap;
}

async function getSupportRoleChannelDates(guild) {
  const supportChannel = client.channels.cache.get(SUPPORT_ROLE_LOG_CHANNEL_ID);
  if (!supportChannel) {
    console.error('❌ روم سجل رتبة الدعم غير موجود!');
    return new Map();
  }

  const dateMap = new Map();
  let lastId = null;
  let fetched = 0;
  const limit = 1000;
  while (fetched < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await supportChannel.messages.fetch(options);
    if (msgs.size === 0) break;
    for (const [, msg] of msgs) {
      const match = msg.content.match(/<@!?(\d+)>/);
      if (match) {
        const userId = match[1];
        if (!dateMap.has(userId)) {
          dateMap.set(userId, msg.createdTimestamp);
        }
      }
    }
    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  return dateMap;
}

async function getRoleAddDateFromAuditLog(guild, userId, roleId) {
  try {
    let before = undefined;
    for (let page = 0; page < 10; page++) {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberRoleUpdate,
        limit: 100,
        before,
      });
      if (!logs.entries.size) break;

      for (const [, entry] of logs.entries) {
        if (!entry.target || entry.target.id !== userId) continue;
        const addChange = entry.changes && entry.changes.find(
          (c) => c.key === '$add' && Array.isArray(c.new) && c.new.some((r) => r.id === roleId)
        );
        if (addChange) {
          return entry.createdTimestamp;
        }
      }

      const lastEntry = logs.entries.last();
      if (!lastEntry) break;
      before = lastEntry.id;
      if (logs.entries.size < 100) break;
    }
  } catch (err) {
    console.error(`❌ خطأ في جلب سجل التدقيق للعضو ${userId}:`, err);
  }
  return null;
}

async function resolveSupportRoleDate(guild, userId, supportChannelDateMap) {
  if (supportChannelDateMap.has(userId)) {
    return supportChannelDateMap.get(userId);
  }
  const auditDate = await getRoleAddDateFromAuditLog(guild, userId, SUPPORT_ROLE_ID);
  if (auditDate) return auditDate;
  return null;
}

function parseDurationToSeconds(text) {
  if (!text) return 0;
  let seconds = 0;
  const hMatch = text.match(/(\d+)\s*h/i);
  const mMatch = text.match(/(\d+)\s*m(?!s)/i);
  const sMatch = text.match(/(\d+)\s*s/i);
  if (hMatch) seconds += parseInt(hMatch[1], 10) * 3600;
  if (mMatch) seconds += parseInt(mMatch[1], 10) * 60;
  if (sMatch) seconds += parseInt(sMatch[1], 10);
  return seconds;
}

function formatSecondsToHoursText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0 && minutes === 0) return '0 دقيقة';
  const parts = [];
  if (hours > 0) parts.push(`${hours} ساعة`);
  if (minutes > 0) parts.push(`${minutes} دقيقة`);
  return parts.join(' و ');
}

async function getTotalHoursMap(guild, targetIds) {
  const channel = client.channels.cache.get(HOURS_LOG_CHANNEL_ID);
  if (!channel) {
    console.error('❌ روم سجل الساعات غير موجود!');
    return new Map();
  }

  const totalMap = new Map();
  const remainingIds = new Set(targetIds);
  let lastId = null;
  let fetched = 0;
  const limit = 3000;

  while (fetched < limit && remainingIds.size > 0) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;

    for (const [, msg] of msgs) {
      if (!msg.embeds || msg.embeds.length === 0) continue;
      const embed = msg.embeds[0];
      const fields = embed.fields || [];
      const adminField = fields.find(f => f.name && f.name.includes('Admin'));
      const totalField = fields.find(f => f.name && f.name.includes('Total Time'));
      if (!adminField || !totalField) continue;

      const match = adminField.value.match(/<@!?(\d+)>/);
      if (!match) continue;
      const userId = match[1];

      if (totalMap.has(userId)) continue;

      const seconds = parseDurationToSeconds(totalField.value);
      totalMap.set(userId, seconds);
      remainingIds.delete(userId);
    }

    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  return totalMap;
}

// ============================================================
// دوال مساعدة لجرد فريق الرقابة (تم دمجها في الجرد الجديد)
// ============================================================

/**
 * تحسب عدد رسائل "done" بأنماط متعددة لكل عضو في قناة معينة خلال آخر 7 أيام.
 */
async function countDoneMessagesPerUser(channel, userIds, cutoffDate) {
  const counts = new Map();
  for (const id of userIds) counts.set(id, 0);

  const patterns = [
    /\bdone\b/i,
    /عدد المساعدات/i,
    /تم حل المشكلة/i,
    /\bnعم\b/i,
    /\d+\s*done/i,
    /DONE/i,
  ];

  let lastId = null;
  let fetched = 0;
  const limit = 5000;

  while (fetched < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;

    for (const [, msg] of msgs) {
      if (msg.createdTimestamp < cutoffDate) continue;
      const isDone = patterns.some(pattern => pattern.test(msg.content));
      if (isDone && counts.has(msg.author.id)) {
        counts.set(msg.author.id, counts.get(msg.author.id) + 1);
      }
    }

    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  return counts;
}

/**
 * تحسب عدد رسائل الباند التي تطابق نمطاً معيناً.
 */
async function countMessagesWithPattern(channel, userIds, pattern, cutoffDate = null) {
  const counts = new Map();
  for (const id of userIds) counts.set(id, 0);

  let lastId = null;
  let fetched = 0;
  const limit = 5000;

  while (fetched < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;

    for (const [, msg] of msgs) {
      if (cutoffDate && msg.createdTimestamp < cutoffDate) continue;
      if (pattern.test(msg.content) && counts.has(msg.author.id)) {
        counts.set(msg.author.id, counts.get(msg.author.id) + 1);
      }
    }

    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  return counts;
}

/**
 * تجلب جميع التقييمات من قناة التقييمات وتحسب المتوسط لكل إداري.
 */
async function getAdminRatings(channel) {
  const ratings = new Map();

  let lastId = null;
  let fetched = 0;
  const limit = 5000;

  while (fetched < limit) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;

    for (const [, msg] of msgs) {
      if (msg.embeds && msg.embeds.length > 0) {
        const embed = msg.embeds[0];
        if (embed.fields) {
          const adminField = embed.fields.find(f => f.name && f.name.includes('الإداري'));
          const ratingField = embed.fields.find(f => f.name && f.name.includes('التقييم'));
          if (adminField && ratingField) {
            const match = adminField.value.match(/<@!?(\d+)>/);
            if (match) {
              const adminId = match[1];
              const ratingMatch = ratingField.value.match(/(\d+)\/5/);
              if (ratingMatch) {
                const rating = parseInt(ratingMatch[1]);
                if (!ratings.has(adminId)) ratings.set(adminId, { sum: 0, count: 0 });
                const data = ratings.get(adminId);
                data.sum += rating;
                data.count++;
              }
            }
          }
        }
      }
    }

    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }

  const result = new Map();
  for (const [adminId, data] of ratings) {
    result.set(adminId, {
      sum: data.sum,
      count: data.count,
      average: data.count > 0 ? data.sum / data.count : 0,
    });
  }
  return result;
}

// ============================================================
// دوال التقارير الجديدة
// ============================================================
async function sendVoiceChannelReport(guild, channelIds, reportChannelId, reportTitle, reportColor = 0x3498db) {
  try {
    const reportChannel = guild.channels.cache.get(reportChannelId);
    if (!reportChannel) {
      console.error(`❌ قناة التقرير ${reportChannelId} غير موجودة!`);
      return;
    }

    const membersInChannels = new Map();
    let totalMembers = 0;

    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.type !== 2) continue;
      const members = channel.members;
      if (members.size > 0) {
        membersInChannels.set(channelId, members);
        totalMembers += members.size;
      }
    }

    if (totalMembers === 0) {
      const embed = new EmbedBuilder()
        .setTitle(`📊 ${reportTitle}`)
        .setDescription('❌ لا يوجد أعضاء في هذه الرومات حالياً.')
        .setColor(reportColor)
        .setTimestamp();
      await reportChannel.send({ embeds: [embed] });
      return;
    }

    let description = '';
    for (const [channelId, members] of membersInChannels) {
      const channel = guild.channels.cache.get(channelId);
      const channelName = channel ? channel.name : channelId;
      description += `\n**<#${channelId}>** (${members.size} عضو):\n`;
      for (const [, member] of members) {
        description += `• ${member.user.tag} (\`${member.id}\`)\n`;
      }
      description += '\n';
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${reportTitle}`)
      .setDescription(description)
      .setColor(reportColor)
      .setFooter({ text: `إجمالي الأعضاء: ${totalMembers}` })
      .setTimestamp();

    await reportChannel.send({ embeds: [embed] });
    console.log(`✅ تم إرسال تقرير ${reportTitle} إلى ${reportChannelId}`);
  } catch (err) {
    console.error(`❌ خطأ في إرسال تقرير ${reportTitle}:`, err);
  }
}

// ============================================================
// خروج تلقائي للإدارة العليا
// ============================================================
async function autoHmCheckout(guild, userId) {
  const nowTimestamp = Math.floor(Date.now() / 1000);
  hmCheckedIn.delete(userId);

  try {
    const logChannel = guild.channels.cache.get(HM_LOG_CHANNEL_ID);
    if (!logChannel) return;

    const user = await client.users.fetch(userId).catch(() => null);

    const logEmbed = new EmbedBuilder()
      .setColor(HM_OUT_COLOR)
      .setTitle('Admin Logout')
      .setDescription('تم تسجيل الخروج تلقائياً بعد مغادرة الروم لمدة دقيقة بدون رجوع.')
      .addFields(
        { name: 'Admin', value: `<@${userId}>\n${userId}`, inline: false },
        { name: 'Logout Time', value: `<t:${nowTimestamp}:F>`, inline: true }
      )
      .setThumbnail(user ? user.displayAvatarURL() : undefined)
      .setTimestamp();

    await logChannel.send({ embeds: [logEmbed] });
    console.log(`🔴 تم تسجيل خروج تلقائي لـ ${userId}`);
  } catch (err) {
    console.error('❌ خطأ في إرسال سجل الخروج التلقائي للإدارة العليا:', err);
  }
}

// ============================================================
// حماية روم الإجازات
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;
    const isAdmin = message.member && hasStaffRole(message.member);
    if (!isAdmin) {
      try { await message.delete(); } catch (err) { /* ignore */ }
    }
  }
});

// ============================================================
// دوال السحب التلقائي
// ============================================================
function isDeafened(voiceState) {
  if (!voiceState) return false;
  return voiceState.selfDeaf || voiceState.serverDeaf;
}

function getNextEligibleWaitingMember(guild) {
  for (const waitingId of WAITING_CHANNEL_IDS) {
    const waitingChannel = guild.channels.cache.get(waitingId);
    if (!waitingChannel || !waitingChannel.members) continue;
    for (const [, member] of waitingChannel.members) {
      if (!hasStaffRole(member)) {
        return { member, waitingChannelId: waitingId };
      }
    }
  }
  return null;
}

function isFreeAdminRoom(channel, targetAdminRoomIds, requiredRoleId = null) {
  if (!channel || channel.type !== 2) return false;
  if (!targetAdminRoomIds.includes(channel.id)) return false;
  const members = [...channel.members.values()];
  if (members.length !== 1) return false;
  const adminMember = members[0];
  if (requiredRoleId && !adminMember.roles.cache.has(requiredRoleId)) return false;
  if (!adminMember.roles.cache.has(ADMIN_ROLE_ID)) return false;
  return !isDeafened(adminMember.voice);
}

async function sendCitizenNotification(citizenUser, adminUser) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎙️ تم توجيهك لإداري')
      .setDescription(`تم نقل طلبك إلى المسؤول ${adminUser}، سيتم نقلك إلى رومه الآن.`)
      .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
      .setFooter({ text: 'جهز ملاحظاتك وأسئلتك' })
      .setTimestamp();

    let logoFile = null;
    try {
      if (fs.existsSync(SERVER_LOGO_PATH)) {
        logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
      }
    } catch (e) {}

    await citizenUser.send({
      embeds: [embed],
      files: logoFile ? [logoFile] : []
    });
  } catch (err) {
    console.error('❌ تعذر إرسال رسالة للمواطن:', err);
  }
}

async function tryPullForAllFreeAdmins(guild) {
  const waitingData = getNextEligibleWaitingMember(guild);
  if (!waitingData) return;

  const { member: candidate, waitingChannelId } = waitingData;

  let targetAdminRoomIds;
  let requiredRoleId;

  const SPECIAL_PULL_WAITING_ROOMS = ['1519511668823167116', '1481398869463138604'];
  const SPECIAL_PULL_REQUIRED_ROLE = '1476796533168017428';
  const SPECIAL_PULL_TARGET_ROOMS = [
    '1538016869968248993',
    '1538019823102070865',
    '1538019839183032330',
    '1538019855465455666',
    '1538019875556032572'
  ];

  if (SPECIAL_PULL_WAITING_ROOMS.includes(waitingChannelId)) {
    if (!candidate.roles.cache.has(SPECIAL_PULL_REQUIRED_ROLE)) {
      console.log(`⏳ العضو ${candidate.user.tag} لا يملك الرتبة المطلوبة للدخول إلى روم الدعم المخصص.`);
      return;
    }
    targetAdminRoomIds = SPECIAL_PULL_TARGET_ROOMS;
    requiredRoleId = SPECIAL_PULL_REQUIRED_ROLE;
  } else {
    const isSpecialCase =
      waitingChannelId === SPECIAL_WAITING_ROOM_ID &&
      candidate.roles.cache.has(SPECIAL_ROLE_ID);

    if (isSpecialCase) {
      targetAdminRoomIds = SPECIAL_ADMIN_ROOM_IDS;
      requiredRoleId = SPECIAL_REQUIRED_ADMIN_ROLE_ID;
    } else if (WAITING_ROOM_ADMIN_MAP[waitingChannelId]) {
      targetAdminRoomIds = WAITING_ROOM_ADMIN_MAP[waitingChannelId];
      requiredRoleId = WAITING_ROOM_REQUIRED_ROLE[waitingChannelId] || ADMIN_ROLE_ID;
    } else {
      targetAdminRoomIds = ADMIN_ROOM_IDS;
      requiredRoleId = ADMIN_ROLE_ID;
    }
  }

  const freeAdmins = [];
  for (const roomId of targetAdminRoomIds) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel) continue;
    if (!isFreeAdminRoom(channel, targetAdminRoomIds, requiredRoleId)) continue;
    const adminMember = channel.members.first();
    freeAdmins.push({ channel, adminMember });
  }

  if (freeAdmins.length === 0) return;
  if (activeSessions.has(candidate.id)) return;

  const eligibleAdmins = freeAdmins.filter(({ adminMember }) => {
    const adminCooldownKey = adminMember.id;
    const adminCooldownEnd = cooldownMap.get(adminCooldownKey);
    if (adminCooldownEnd && adminCooldownEnd > Date.now()) return false;

    const pairKey = `${adminMember.id}_${candidate.id}`;
    const pairCooldownEnd = cooldownMap.get(pairKey);
    if (pairCooldownEnd && pairCooldownEnd > Date.now()) return false;
    return true;
  });

  if (eligibleAdmins.length === 0) {
    console.log(`⏳ جميع الإداريين المتفرغين في الكول داون مع ${candidate.user.tag}`);
    return;
  }

  const { adminMember } = eligibleAdmins[0];
  const adminChannel = adminMember.voice.channel;
  if (!adminChannel) return;

  try {
    await candidate.voice.setChannel(adminChannel.id, 'سحب تلقائي - جلسة دعم');
    activeSessions.set(candidate.id, {
      adminId: adminMember.id,
      startTime: Date.now()
    });
    cooldownMap.set(adminMember.id, Date.now() + 15 * 1000);
    await sendCitizenNotification(candidate.user, adminMember.user);
    console.log(`✅ تم سحب ${candidate.user.tag} إلى ${adminMember.user.tag}`);
  } catch (err) {
    console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
  }
}

// ============================================================
// دالة إنهاء الجلسة مع إرسال تقييم
// ============================================================
async function endSession(guild, citizenId, adminId, startTime) {
  const durationSec = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationText = minutes > 0 ? `${minutes} دقيقة و ${seconds} ثانية` : `${seconds} ثانية`;

  const cooldownKey = `${adminId}_${citizenId}`;
  cooldownMap.set(cooldownKey, Date.now() + 60 * 1000);

  const sessionId = `${adminId}_${citizenId}_${startTime}`;
  activeSessions.delete(citizenId);

  try {
    const citizenUser = await client.users.fetch(citizenId);
    const row = new ActionRowBuilder().addComponents(
      [1, 2, 3, 4, 5].map(r => 
        new ButtonBuilder()
          .setCustomId(`rate_${r}_${adminId}_${sessionId}`)
          .setLabel(`${r}⭐`)
          .setStyle(r === 5 ? ButtonStyle.Success : ButtonStyle.Secondary)
      )
    );

    const dmEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📝 تقييم الخدمة')
      .setDescription(`تم الانتهاء من خدمتك بواسطة <@${adminId}> في مدة ${durationText}.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`)
      .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
      .setTimestamp();

    let logoFile = null;
    try {
      if (fs.existsSync(SERVER_LOGO_PATH)) {
        logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
      }
    } catch (e) {}

    await citizenUser.send({
      embeds: [dmEmbed],
      components: [row],
      files: logoFile ? [logoFile] : []
    });
  } catch (err) {
    console.error('⚠️ تعذر إرسال رسالة التقييم للمواطن:', err);
  }
}

// ============================================================
// تسجيل الأوامر (معدل)
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);

  const commands = [
    { name: 'leave_panel', description: 'لوحة طلبات الإجازات والاستقالات' },
    { name: 'active_leaves', description: 'عرض الإداريين المأجزيين' },
    { name: 'barren', description: 'جرد شامل لفريقي التفعيل والرقابة (آخر 7 أيام)' },
    { name: 'privacy', description: 'سياسة الخصوصية' },
    { name: 'hm_panel', description: 'لوحة تسجيل الدخول/الخروج للإدارة' },
    { name: 'restart', description: 'إعادة تشغيل البوت' },
    { name: 'censorship_report', description: 'عرض أعضاء رومات الرقابة' },
    { name: 'activation_report', description: 'عرض أعضاء رومات التفعيل' },
    { name: 'high_staff_report', description: 'عرض أعضاء رومات الإدارة العليا' },
    {
      name: 'clear',
      description: 'حذف الرسائل من روم محددة',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
      options: [
        { name: 'channel', description: 'الروم المراد مسح الرسائل منها', type: 7, required: false },
        { name: 'amount', description: 'عدد الرسائل', type: 4, required: false, min_value: 1, max_value: 100 }
      ]
    },
    { name: 'مفتوح', description: 'فتح التفعيل وإرسال إشعار' },
    { name: 'مغلق', description: 'إغلاق التفعيل وإرسال إشعار' }
  ];

  try {
    // تسجيل الأوامر في السيرفر فقط (لتجنب التكرار)
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر في السيرفر بنجاح.');
  } catch (error) {
    console.error('❌ فشل تسجيل الأوامر في السيرفر:', error);
  }
});

// ============================================================
// أحداث الصوت (بدون STT)
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  // ===== تتبع دخول/خروج الإدارة العليا =====
  const isNowInHmRoom = newState.channelId && HM_REQUIRED_VOICE_CHANNEL_IDS.includes(newState.channelId);
  const wasInHmRoom = oldState.channelId && HM_REQUIRED_VOICE_CHANNEL_IDS.includes(oldState.channelId);

  if (isNowInHmRoom && hmLeaveTimers.has(userId)) {
    clearTimeout(hmLeaveTimers.get(userId));
    hmLeaveTimers.delete(userId);
    console.log(`✅ ${userId} رجع لروم High Management، تم إلغاء مؤقت الخروج التلقائي.`);
  }

  if (wasInHmRoom && !isNowInHmRoom && hmCheckedIn.has(userId)) {
    if (hmLeaveTimers.has(userId)) {
      clearTimeout(hmLeaveTimers.get(userId));
    }
    const timer = setTimeout(async () => {
      try {
        const currentMember = await guild.members.fetch(userId).catch(() => null);
        const currentChannelId = currentMember?.voice?.channelId || null;
        const stillOutside = !currentChannelId || !HM_REQUIRED_VOICE_CHANNEL_IDS.includes(currentChannelId);
        if (stillOutside && hmCheckedIn.has(userId)) {
          await autoHmCheckout(guild, userId);
        }
      } catch (err) {
        console.error('❌ خطأ في فحص الخروج التلقائي للإدارة العليا:', err);
      } finally {
        hmLeaveTimers.delete(userId);
      }
    }, HM_AUTO_OUT_TIMEOUT_MS);
    hmLeaveTimers.set(userId, timer);
  }

  // ===== جلسات المواطنين مع الإداريين =====
  const session = activeSessions.get(userId);
  if (session) {
    const adminId = session.adminId;
    const adminMember = await guild.members.fetch(adminId).catch(() => null);
    if (!adminMember) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }

    const adminVoice = adminMember.voice;
    const wasInAdminRoom = oldState.channelId && ADMIN_ROOM_IDS.includes(oldState.channelId);
    const isInAdminRoom = newState.channelId && ADMIN_ROOM_IDS.includes(newState.channelId);
    if (wasInAdminRoom && !isInAdminRoom) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }
    if (adminVoice.channelId && !ADMIN_ROOM_IDS.includes(adminVoice.channelId)) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }
    if (isDeafened(adminVoice)) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }
    if (!adminVoice.channelId) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }
  }

  // ===== التنبيه الخاص بروم 1483285123008041031 =====
  const isCustomRoom = newState.channelId === CUSTOM_WAITING_ROOM_ID;
  const wasCustomRoom = oldState.channelId === CUSTOM_WAITING_ROOM_ID;

  if (isCustomRoom && !wasCustomRoom) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !hasStaffRole(member)) {
      if (customWaitingTimers.has(userId)) {
        clearTimeout(customWaitingTimers.get(userId));
        customWaitingTimers.delete(userId);
      }
      const timer = setTimeout(async () => {
        try {
          const currentMember = await guild.members.fetch(userId).catch(() => null);
          if (!currentMember) return;
          const voiceChannel = currentMember.voice.channel;
          if (!voiceChannel || voiceChannel.id !== CUSTOM_WAITING_ROOM_ID) return;
          if (hasStaffRole(currentMember)) return;
          const channel = guild.channels.cache.get(CUSTOM_NOTIFICATION_CHANNEL_ID);
          if (channel) {
            await channel.send(`<@&${CUSTOM_MENTION_ROLE_ID}> يوجد شخص في الانتظار، يرجى التوجه لخدمته.`);
          }
          customWaitingTimers.delete(userId);
        } catch (err) {
          console.error('❌ خطأ في تنبيه الانتظار الخاص:', err);
        }
      }, CUSTOM_WAITING_TIMEOUT_MS);
      customWaitingTimers.set(userId, timer);
      console.log(`⏳ بدأ مؤقت دقيقتين للعضو ${userId} في الروم المخصص.`);
    }
  }
  if (!isCustomRoom && wasCustomRoom) {
    if (customWaitingTimers.has(userId)) {
      clearTimeout(customWaitingTimers.get(userId));
      customWaitingTimers.delete(userId);
      console.log(`⏹️ تم إلغاء مؤقت العضو ${userId} بعد مغادرة الروم المخصص.`);
    }
  }

  // ===== التنبيه العام =====
  const isGeneralWaiting = WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId) && newState.channelId !== CUSTOM_WAITING_ROOM_ID;
  const isLeavingGeneral = WAITING_CHANNEL_IDS.includes(oldState.channelId) && !WAITING_CHANNEL_IDS.includes(newState.channelId) && oldState.channelId !== CUSTOM_WAITING_ROOM_ID;

  if (isGeneralWaiting) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !hasStaffRole(member)) {
      if (waitingTimers.has(userId)) clearTimeout(waitingTimers.get(userId).timeout);
      const timer = setTimeout(async () => {
        try {
          const currentMember = await guild.members.fetch(userId).catch(() => null);
          if (!currentMember) return;
          const voiceChannel = currentMember.voice.channel;
          if (!voiceChannel || !WAITING_CHANNEL_IDS.includes(voiceChannel.id)) return;
          if (hasStaffRole(currentMember)) return;
          const channel = guild.channels.cache.get(WAITING_NOTIFICATION_CHANNEL_ID);
          if (channel) {
            await channel.send(`<@&${WAITING_MENTION_ROLE_ID}> يوجد شخص في الانتظار، يرجى التوجه لخدمته.`);
          }
          const entry = waitingTimers.get(userId);
          if (entry) entry.sent = true;
        } catch (err) {
          console.error('❌ خطأ في تنبيه الانتظار العام:', err);
        }
      }, WAITING_TIMEOUT_MS);
      waitingTimers.set(userId, { timeout: timer, channelId: newState.channelId, sent: false });
    }
  }
  if (isLeavingGeneral) {
    const entry = waitingTimers.get(userId);
    if (entry) { clearTimeout(entry.timeout); waitingTimers.delete(userId); }
  }

  // ===== السحب التلقائي =====
  const enteredAnyWaiting = WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId);
  if (enteredAnyWaiting) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !hasStaffRole(member)) {
      try { await tryPullForAllFreeAdmins(guild); } catch (err) { console.error('❌ خطأ في السحب (enteredWaiting):', err); }
    }
  }
  try { await tryPullForAllFreeAdmins(guild); } catch (err) { console.error('خطأ في السحب:', err); }
});

// ============================================================
// دالة مساعدة: تعديل رتبة عضو بأمان
// ============================================================
async function safeRoleAction(guild, target, action, roleId, label) {
  const botMember = await guild.members.fetchMe();
  const role = guild.roles.cache.get(roleId);

  if (!role) {
    throw new Error(`الرول "${label}" (${roleId}) غير موجود بالسيرفر — تأكد من الآيدي.`);
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('البوت ما يملك صلاحية "Manage Roles" أساسًا بالسيرفر.');
  }
  if (botMember.roles.highest.position <= role.position) {
    throw new Error(`رول البوت لازم يكون أعلى من رول "${role.name}" بترتيب الرولات (إعدادات السيرفر > Roles).`);
  }
  if (botMember.roles.highest.position <= target.roles.highest.position) {
    throw new Error(`رول البوت لازم يكون أعلى من أعلى رول عند ${target.user.tag}.`);
  }
  await action();
}

// ============================================================
// معالج التفاعلات (الإجازات + التقييم + الأوامر) - تم تعديله
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ===== أزرار التقييم =====
    if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
      const parts = interaction.customId.split('_');
      const rating = parseInt(parts[1]);
      const adminId = parts[2];
      const sessionId = parts.slice(3).join('_');

      if (isSessionEvaluated(sessionId)) {
        return interaction.reply({ content: '⚠️ تم التقييم مسبقاً.', ephemeral: true });
      }

      markSessionEvaluated(sessionId);

      const stars = ratingStarsBar(rating);

      await interaction.update({
        content: `✅ شكراً لك! (${stars})`,
        embeds: [],
        components: []
      });

      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const channel = guild.channels.cache.get(RATING_CHANNEL_ID);
        if (channel) {
          const files = [];
          if (fs.existsSync(SERVER_LOGO_PATH)) {
            files.push(new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME }));
          }

          const embed = new EmbedBuilder()
            .setColor(ratingColor(rating))
            .setAuthor({ name: `${interaction.user.username} قيّم الخدمة`, iconURL: interaction.user.displayAvatarURL() })
            .setTitle('🌟 تقييم إداري جديد')
            .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
            .addFields(
              { name: 'المواطن', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'الإداري', value: `<@${adminId}>`, inline: true },
              { name: '⭐ التقييم', value: `${stars}\n\`${rating}/5\` — ${ratingLabel(rating)}`, inline: false }
            )
            .setTimestamp();
          await channel.send({ embeds: [embed], files });
        }
      } catch (e) {
        console.error('❌ خطأ في إرسال التقييم إلى القناة:', e);
      }

      return;
    }

    // ===== أزرار تسجيل الدخول/الخروج للإدارة العليا =====
    if (interaction.isButton() && (interaction.customId === 'hm_check_in' || interaction.customId === 'hm_check_out')) {
      const isIn = interaction.customId === 'hm_check_in';

      const memberVoiceChannelId = interaction.member.voice.channelId;
      const isInAllowedRoom = memberVoiceChannelId && HM_REQUIRED_VOICE_CHANNEL_IDS.includes(memberVoiceChannelId);

      if (!isInAllowedRoom) {
        const roomsList = HM_REQUIRED_VOICE_CHANNEL_IDS.map(id => `<#${id}>`).join('\n');
        return interaction.reply({
          content: `❌ لازم تكون داخل أحد الرومات التالية عشان تقدر تسجل ${isIn ? 'دخول (IN)' : 'خروج (OUT)'}:\n${roomsList}`,
          ephemeral: true
        });
      }

      const nowTimestamp = Math.floor(Date.now() / 1000);

      try {
        const logChannel = interaction.guild.channels.cache.get(HM_LOG_CHANNEL_ID);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(isIn ? HM_IN_COLOR : HM_OUT_COLOR)
            .setTitle(isIn ? 'Admin Login' : 'Admin Logout')
            .addFields(
              { name: 'Admin', value: `<@${interaction.user.id}>\n${interaction.user.id}`, inline: false },
              { name: 'Voice Channel', value: `<#${memberVoiceChannelId}>`, inline: true },
              { name: isIn ? 'Login Time' : 'Logout Time', value: `<t:${nowTimestamp}:F>`, inline: true }
            )
            .setThumbnail(interaction.user.displayAvatarURL())
            .setTimestamp();
          await logChannel.send({ embeds: [logEmbed] });
        }

        if (hmLeaveTimers.has(interaction.user.id)) {
          clearTimeout(hmLeaveTimers.get(interaction.user.id));
          hmLeaveTimers.delete(interaction.user.id);
        }
        if (isIn) {
          hmCheckedIn.set(interaction.user.id, true);
        } else {
          hmCheckedIn.delete(interaction.user.id);
        }

        await interaction.reply({
          content: isIn ? '✅ تم تسجيل دخولك (IN).' : '✅ تم تسجيل خروجك (OUT).',
          ephemeral: true
        });
      } catch (err) {
        console.error('❌ خطأ في تسجيل دخول/خروج الإدارة العليا:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ حدث خطأ أثناء التسجيل.', ephemeral: true }).catch(() => null);
        }
      }
      return;
    }

    // ===== باقي الأزرار (الإجازات) =====
    if (interaction.isButton()) {
      try {
        // زر طلب إجازة
        if (interaction.customId === 'open_leave_modal') {
          const modal = new ModalBuilder()
            .setCustomId('leave_modal')
            .setTitle('📄 طلب إجازة')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('leave_duration')
                  .setLabel(`عدد الأيام (أقصى ${MAX_LEAVE_DAYS})`)
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('مثال: 3')
                  .setRequired(true)
                  .setMaxLength(2)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('leave_reason')
                  .setLabel('سبب الإجازة')
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder('اكتب السبب بالتفصيل')
                  .setRequired(true)
                  .setMaxLength(500)
              )
            );
          await interaction.showModal(modal);
          return;
        }

        // زر كسر إجازة
        if (interaction.customId === 'open_break_modal') {
          const modal = new ModalBuilder()
            .setCustomId('break_modal')
            .setTitle('🔓 طلب كسر إجازة')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('break_reason')
                  .setLabel('سبب كسر الإجازة')
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder('اكتب السبب بالتفصيل')
                  .setRequired(true)
                  .setMaxLength(500)
              )
            );
          await interaction.showModal(modal);
          return;
        }

        // زر استقالة
        if (interaction.customId === 'open_resign_modal') {
          const modal = new ModalBuilder()
            .setCustomId('resign_modal')
            .setTitle('📝 طلب استقالة')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('resign_reason')
                  .setLabel('سبب الاستقالة')
                  .setStyle(TextInputStyle.Paragraph)
                  .setPlaceholder('اكتب السبب بالتفصيل')
                  .setRequired(true)
                  .setMaxLength(500)
              )
            );
          await interaction.showModal(modal);
          return;
        }

        // أزرار قبول/رفض الطلبات
        if (interaction.customId && (interaction.customId.startsWith('req_accept_') || interaction.customId.startsWith('req_reject_'))) {
          if (!hasStaffRole(interaction.member)) {
            return interaction.reply({ content: '❌ هذا الإجراء خاص بالإدارة.', ephemeral: true });
          }

          const parts = interaction.customId.split('_');
          const decision = parts[1];
          const reqType = parts[2];
          const requesterId = parts[3];
          const isAccept = decision === 'accept';

          const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
          const fields = originalEmbed.data.fields || [];
          const statusIndex = fields.findIndex(f => f.name.includes('الحالة'));
          const statusValue = `\`\`\`\n${isAccept ? '✅ تم القبول' : '❌ تم الرفض'} بواسطة ${interaction.user.username}\n\`\`\``;
          if (statusIndex >= 0) fields[statusIndex].value = statusValue;
          else fields.push({ name: 'الحالة', value: statusValue });
          originalEmbed.setFields(fields).setColor(isAccept ? 0x2ecc71 : 0xe74c3c);

          const disabledRow = new ActionRowBuilder().addComponents(
            interaction.message.components[0].components.map(btn => ButtonBuilder.from(btn).setDisabled(true))
          );
          await interaction.update({ embeds: [originalEmbed], components: [disabledRow] });

          if (isAccept) {
            let target = null;
            try {
              target = await interaction.guild.members.fetch(requesterId);

              if (reqType === 'leave') {
                await safeRoleAction(interaction.guild, target, () => target.roles.add(LEAVE_ROLE_ID), LEAVE_ROLE_ID, 'رول الإجازة');
                const durationField = originalEmbed.data.fields.find(f => f.name.includes('المدة'));
                if (durationField) {
                  const match = durationField.value.match(/\d+/);
                  if (match) {
                    const days = parseInt(match[0]);
                    activeLeaves.set(requesterId, { endDate: Date.now() + days * 24*60*60*1000 });
                    saveActiveLeaves();
                  }
                }
              } else if (reqType === 'resign') {
                await safeRoleAction(interaction.guild, target, () => target.roles.set([RESIGNATION_KEEP_ROLE_ID]), RESIGNATION_KEEP_ROLE_ID, 'رول الاستقالة');
                try {
                  await target.setNickname(null, 'تم قبول الاستقالة - حذف النيك نيم');
                } catch (nickErr) {
                  console.error('⚠️ فشل حذف النيك نيم:', nickErr);
                }
              } else if (reqType === 'break') {
                if (target.roles.cache.has(LEAVE_ROLE_ID)) {
                  await safeRoleAction(interaction.guild, target, () => target.roles.remove(LEAVE_ROLE_ID), LEAVE_ROLE_ID, 'رول الإجازة');
                }
                if (activeLeaves.has(requesterId)) {
                  activeLeaves.delete(requesterId);
                  saveActiveLeaves();
                }
              }
            } catch (e) {
              console.error('⚠️ خطأ في تعديل الرتب:', e);
              await interaction.followUp({
                content: `⚠️ تم قبول الطلب لكن **تعديل الرتب فشل**:\n\`${e.message || 'صلاحيات البوت غير كافية.'}\`\nراجع صلاحية Manage Roles وترتيب رول البوت بإعدادات السيرفر > Roles.`,
                ephemeral: true
              }).catch(() => null);
            }
          }

          try {
            const user = await client.users.fetch(requesterId);
            const typeLabels = { leave: 'إجازة', resign: 'استقالة', break: 'كسر إجازة' };
            await user.send({
              embeds: [
                new EmbedBuilder()
                  .setTitle(isAccept ? '🎉 تم القبول' : '❌ تم الرفض')
                  .setColor(isAccept ? 0x2ecc71 : 0xe74c3c)
                  .setDescription(isAccept ? `تم قبول طلب ${typeLabels[reqType]}` : `تم رفض طلب ${typeLabels[reqType]}`)
                  .addFields({ name: 'المسؤول', value: `<@${interaction.user.id}>` })
                  .setTimestamp()
              ]
            });
          } catch (e) { /* ignore */ }
          return;
        }
      } catch (buttonError) {
        console.error('❌ خطأ في زر الإجازات:', buttonError);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ حدث خطأ أثناء فتح النافذة، حاول مرة أخرى.', ephemeral: true }).catch(() => {});
        }
        return;
      }
    }

    // ===== المودالات =====
    if (interaction.isModalSubmit()) {
      const requestsChannel = await interaction.guild.channels.fetch(LEAVE_PANEL_CHANNEL_ID);
      const buildEmbed = (title, fields) => new EmbedBuilder()
        .setColor(0x2f3136)
        .setTitle(`📨 طلب جديد (${title})`)
        .setDescription(`**من:** <@${interaction.user.id}>`)
        .addFields(fields)
        .setTimestamp();
      const mentionContent = LEAVE_REQUEST_MENTION_ROLE_IDS.map(id => `<@&${id}>`).join(' ');
      const mentionAllowed = { roles: LEAVE_REQUEST_MENTION_ROLE_IDS };

      if (interaction.customId === 'leave_modal') {
        const duration = parseInt(interaction.fields.getTextInputValue('leave_duration'));
        const reason = interaction.fields.getTextInputValue('leave_reason');
        if (isNaN(duration) || duration < 1 || duration > MAX_LEAVE_DAYS) {
          return interaction.reply({ content: `❌ أدخل عدد أيام بين 1 و ${MAX_LEAVE_DAYS}.`, ephemeral: true });
        }
        const embed = buildEmbed('طلب إجازة', [
          { name: 'المدة', value: `\`${duration} يوم\`` },
          { name: 'السبب', value: `\`\`\`${reason}\`\`\`` },
          { name: 'الحالة', value: '⏳ بانتظار المراجعة' }
        ]);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req_accept_leave_${interaction.user.id}`).setLabel('قبول').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`req_reject_leave_${interaction.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger)
        );
        await requestsChannel.send({ content: mentionContent, embeds: [embed], components: [row], allowedMentions: mentionAllowed });
        return interaction.reply({ content: '✅ تم إرسال طلب الإجازة.', ephemeral: true });
      }

      if (interaction.customId === 'resign_modal') {
        const reason = interaction.fields.getTextInputValue('resign_reason');
        const embed = buildEmbed('طلب استقالة', [
          { name: 'السبب', value: `\`\`\`${reason}\`\`\`` },
          { name: 'الحالة', value: '⏳ بانتظار المراجعة' }
        ]);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req_accept_resign_${interaction.user.id}`).setLabel('قبول').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`req_reject_resign_${interaction.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger)
        );
        await requestsChannel.send({ content: mentionContent, embeds: [embed], components: [row], allowedMentions: mentionAllowed });
        return interaction.reply({ content: '✅ تم إرسال طلب الاستقالة.', ephemeral: true });
      }

      if (interaction.customId === 'break_modal') {
        const reason = interaction.fields.getTextInputValue('break_reason');
        const embed = buildEmbed('طلب كسر إجازة', [
          { name: 'السبب', value: `\`\`\`${reason}\`\`\`` },
          { name: 'الحالة', value: '⏳ بانتظار المراجعة' }
        ]);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`req_accept_break_${interaction.user.id}`).setLabel('قبول').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`req_reject_break_${interaction.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger)
        );
        await requestsChannel.send({ content: mentionContent, embeds: [embed], components: [row], allowedMentions: mentionAllowed });
        return interaction.reply({ content: '✅ تم إرسال طلب كسر الإجازة.', ephemeral: true });
      }
    }

    // ===== الأوامر (سلاش) =====
    if (interaction.isChatInputCommand()) {
      // /restart
      if (interaction.commandName === 'restart') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بصلاحية Administrator فقط.', ephemeral: true });
        }
        await interaction.reply({ content: '🔄 جاري إعادة تشغيل البوت...' });
        console.log(`🔄 إعادة تشغيل مطلوبة من ${interaction.user.tag} (${interaction.user.id})`);
        setTimeout(() => process.exit(0), 800);
        return;
      }

      // /leave_panel
      if (interaction.commandName === 'leave_panel') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }

        const panelEmbed = new EmbedBuilder()
          .setTitle('📋 نظام طلبات الإجازات والاستقالات')
          .setDescription(
            `اختر نوع الطلب من الأزرار:\n\n` +
            `📄 **طلب إجازة** (حد أقصى ${MAX_LEAVE_DAYS} يوم)\n` +
            `🔓 **طلب كسر إجازة**\n` +
            `📝 **طلب استقالة**`
          )
          .setColor(LEAVE_PANEL_COLOR)
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_leave_modal').setLabel('طلب إجازة').setEmoji('📄').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('open_break_modal').setLabel('كسر إجازة').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('open_resign_modal').setLabel('استقالة').setEmoji('📝').setStyle(ButtonStyle.Danger)
        );

        try {
          const channel = await interaction.guild.channels.fetch(LEAVE_EMBED_CHANNEL_ID);
          if (!channel) {
            return interaction.reply({ content: `❌ الروم <#${LEAVE_EMBED_CHANNEL_ID}> غير موجود.`, ephemeral: true });
          }
          await channel.send({ embeds: [panelEmbed], components: [row] });
          return interaction.reply({ content: `✅ تم إرسال اللوحة إلى <#${LEAVE_EMBED_CHANNEL_ID}>.`, ephemeral: true });
        } catch (err) {
          console.error('❌ فشل إرسال لوحة الإجازات:', err);
          return interaction.reply({ content: `❌ حدث خطأ أثناء إرسال اللوحة: ${err.message}`, ephemeral: true });
        }
      }

      // /active_leaves
      if (interaction.commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        if (activeLeaves.size === 0) return interaction.reply({ content: '🌴 لا يوجد إداري في إجازة.', ephemeral: true });
        let desc = '';
        let index = 1;
        for (const [userId, data] of activeLeaves) {
          const remaining = data.endDate - Date.now();
          if (remaining <= 0) { activeLeaves.delete(userId); saveActiveLeaves(); continue; }
          const days = Math.floor(remaining / (1000*60*60*24));
          const hours = Math.floor((remaining % (1000*60*60*24)) / (1000*60*60));
          desc += `**${index}.** <@${userId}> — متبقي: \`${days} يوم و ${hours} ساعة\`\n`;
          index++;
        }
        if (!desc) desc = '✅ جميع الإجازات انتهت.';
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📋 الإجازات النشطة').setColor(0x3ba55d).setDescription(desc)] });
      }

      // ===== الأمر المدمج /barren (مع التعديلات الجديدة) =====
      if (interaction.commandName === 'barren') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }

        await interaction.deferReply();

        const guild = interaction.guild;

        // جلب الرتبة المستهدفة
        await guild.members.fetch();
        const targetRole = guild.roles.cache.get(INVENTORY_TARGET_ROLE_ID);
        if (!targetRole) {
          return interaction.editReply({ content: '❌ الرتبة المستهدفة غير موجودة.' });
        }

        const members = targetRole.members;
        if (members.size === 0) {
          return interaction.editReply({ content: '❌ لا يوجد أعضاء في هذه الرتبة.' });
        }

        const userIds = [...members.keys()];

        // جلب تاريخ آخر ترقية لكل عضو
        const promotionDateMap = await getLastPromotionDate(guild);

        // تحديد أقدم تاريخ بين جميع الأعضاء (سنستخدمه كحد أدنى لجلب الرسائل)
        let oldestCutoff = Date.now();
        for (const userId of userIds) {
          const promoDate = promotionDateMap.get(userId);
          if (promoDate && promoDate < oldestCutoff) {
            oldestCutoff = promoDate;
          }
        }
        // إذا لم يكن لأي عضو ترقية، نستخدم آخر 7 أيام
        if (oldestCutoff === Date.now()) {
          oldestCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        }

        // جلب جميع الرسائل من القنوات المطلوبة (بدون فلترة زمنية، لكننا سنستخدم oldestCutoff لجلب أقل قدر ممكن)
        // لكننا سنستخدم fetchMessagesFromDate مع oldestCutoff لجلب الرسائل من أقدم تاريخ مطلوب.
        const [activationMsgs, rejectionMsgs, reactivationMsgs] = await Promise.all([
          fetchMessagesFromDate(ACTIVATION_CHANNEL_ID, oldestCutoff),
          fetchMessagesFromDate(REJECTION_CHANNEL_ID, oldestCutoff),
          fetchMessagesFromDate(REACTIVATION_CHANNEL_ID, oldestCutoff)
        ]);

        // دالة لحساب عدد مرات منشن عضو في قائمة رسائل مع فلترة زمنية خاصة
        const countMentionsWithCutoff = (msgs, userId, cutoffDate) => {
          let count = 0;
          for (const msg of msgs) {
            if (msg.createdTimestamp >= cutoffDate && msg.content.includes(`<@${userId}>`)) {
              count++;
            }
          }
          return count;
        };

        // 2. جلب الساعات من الرومين (هذه لا تعتمد على التاريخ، بل على أحدث إمبيد)
        const hoursMap = new Map();
        for (const channelId of HOURS_CHANNEL_IDS) {
          const channel = guild.channels.cache.get(channelId);
          if (!channel) {
            console.warn(`⚠️ قناة الساعات ${channelId} غير موجودة`);
            continue;
          }
          const latestFields = await getLatestEmbedFieldPerUser(channel, userIds, 'Total Time');
          for (const [userId, value] of latestFields) {
            const seconds = parseDurationToSeconds(value);
            hoursMap.set(userId, (hoursMap.get(userId) || 0) + seconds);
          }
        }

        // =====================================================
        // 3. جلب عدد المساعدات (الدن) - طريقة جديدة: عدد رسائل العضو في القناة DONE_CHANNEL_ID
        // =====================================================
        const doneChannel = guild.channels.cache.get(DONE_CHANNEL_ID);
        const doneMap = new Map();
        // تهيئة جميع المستخدمين بـ 0
        for (const userId of userIds) doneMap.set(userId, 0);

        if (doneChannel) {
          // جلب جميع رسائل القناة من أقدم تاريخ ممكن (oldestCutoff)
          const allDoneMessages = await fetchMessagesFromDate(DONE_CHANNEL_ID, oldestCutoff);
          for (const msg of allDoneMessages) {
            const userId = msg.author.id;
            if (doneMap.has(userId)) {
              // تحديد القطع الزمني الخاص بهذا العضو (مثلما نفعل مع التفعيلات)
              let userCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // افتراضي
              const member = members.get(userId);
              let isPromotionBased = false;
              if (member) {
                for (const roleId of PROMOTION_BASED_ROLES) {
                  if (member.roles.cache.has(roleId)) {
                    isPromotionBased = true;
                    break;
                  }
                }
              }
              if (isPromotionBased) {
                const promoDate = promotionDateMap.get(userId);
                if (promoDate) userCutoff = promoDate;
                else userCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
              }
              if (msg.createdTimestamp >= userCutoff) {
                doneMap.set(userId, doneMap.get(userId) + 1);
              }
            }
          }
        }

        // 4. جلب التقييمات
        const ratingsChannel = guild.channels.cache.get(RATING_CHANNEL_ID);
        let ratingsData = new Map();
        if (ratingsChannel) {
          ratingsData = await getAdminRatings(ratingsChannel);
        }

        // تجميع الإحصائيات لكل عضو بناءً على نوع الرتبة
        const stats = new Map();
        for (const userId of userIds) {
          // تحديد الـ cutoff لهذا العضو: إذا كان في الرتب المعتمدة على الترقية، نستخدم تاريخ ترقيته، وإلا نستخدم آخر 7 أيام
          let cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // القيمة الافتراضية
          // نتحقق مما إذا كان العضو يمتلك أي رتبة من PROMOTION_BASED_ROLES
          const member = members.get(userId);
          let isPromotionBased = false;
          if (member) {
            for (const roleId of PROMOTION_BASED_ROLES) {
              if (member.roles.cache.has(roleId)) {
                isPromotionBased = true;
                break;
              }
            }
          }
          if (isPromotionBased) {
            const promoDate = promotionDateMap.get(userId);
            if (promoDate) {
              cutoff = promoDate;
            } else {
              // إذا لم يكن له ترقية، نستخدم آخر 7 أيام أيضاً
              cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            }
          }

          const activationCount = countMentionsWithCutoff(activationMsgs, userId, cutoff);
          const rejectionCount = countMentionsWithCutoff(rejectionMsgs, userId, cutoff);
          const reactivationCount = countMentionsWithCutoff(reactivationMsgs, userId, cutoff);
          const totalHours = hoursMap.get(userId) || 0;
          const doneCount = doneMap.get(userId) || 0;
          const ratingInfo = ratingsData.get(userId);
          const avgRating = ratingInfo ? ratingInfo.average : 0;
          const ratingCount = ratingInfo ? ratingInfo.count : 0;
          const lastPromotion = promotionDateMap.get(userId) || null;

          stats.set(userId, {
            activationCount,
            rejectionCount,
            reactivationCount,
            totalHours,
            doneCount,
            avgRating,
            ratingCount,
            lastPromotion,
            isPromotionBased // لتحديد نوع العرض لاحقاً
          });
        }

        // تجميع الأعضاء حسب ترتيب الرتب
        const assignedIds = new Set();
        const grouped = [];

        // 1. الرتب العادية (غير المعتمدة على الترقية)
        const normalRoles = ROLE_ORDER.filter(roleId => !PROMOTION_BASED_ROLES.includes(roleId));
        for (const roleId of normalRoles) {
          const roleObj = guild.roles.cache.get(roleId);
          const entries = [];
          for (const userId of userIds) {
            if (assignedIds.has(userId)) continue;
            const member = members.get(userId);
            if (member && member.roles.cache.has(roleId)) {
              entries.push({ userId, member, stats: stats.get(userId) });
              assignedIds.add(userId);
            }
          }
          // ترتيب حسب عدد التفعيلات ثم الساعات
          entries.sort((a, b) => b.stats.activationCount - a.stats.activationCount || b.stats.totalHours - a.stats.totalHours);
          grouped.push({ roleId, roleObj, entries, type: 'normal' });
        }

        // 2. الرتب المعتمدة على الترقية
        for (const roleId of PROMOTION_BASED_ROLES) {
          const roleObj = guild.roles.cache.get(roleId);
          const entries = [];
          for (const userId of userIds) {
            if (assignedIds.has(userId)) continue;
            const member = members.get(userId);
            if (member && member.roles.cache.has(roleId)) {
              entries.push({ userId, member, stats: stats.get(userId) });
              assignedIds.add(userId);
            }
          }
          // ترتيب حسب تاريخ آخر ترقية (الأحدث أولاً)
          entries.sort((a, b) => (b.stats.lastPromotion || 0) - (a.stats.lastPromotion || 0));
          grouped.push({ roleId, roleObj, entries, type: 'promotion' });
        }

        // الأعضاء الذين ليس لديهم أي رتبة من القائمة
        const noRoleEntries = [];
        for (const userId of userIds) {
          if (!assignedIds.has(userId)) {
            const member = members.get(userId);
            noRoleEntries.push({ userId, member, stats: stats.get(userId) });
          }
        }
        noRoleEntries.sort((a, b) => b.stats.activationCount - a.stats.activationCount || b.stats.totalHours - a.stats.totalHours);
        grouped.push({ roleId: null, roleObj: null, entries: noRoleEntries, type: 'normal' });

        // بناء النص
        let bodyText = '';
        let totalCount = 0;

        for (const group of grouped) {
          if (group.entries.length === 0) continue;
          const roleLabel = group.roleObj ? group.roleObj.name : 'بدون رتبة من القائمة';
          const roleIdStr = group.roleId ? `<@&${group.roleId}>` : '';
          bodyText += `\n__**${roleLabel}**__ ${roleIdStr}\n`;
          bodyText += `━━━━━━━━━━━━━━━━━━\n`;
          for (const entry of group.entries) {
            const s = entry.stats;
            const avgRatingStr = s.avgRating ? s.avgRating.toFixed(1) : '0.0';
            const stars = s.avgRating ? ratingStarsBar(Math.round(s.avgRating)) : '☆☆☆☆☆';
            bodyText += `▪️ **الاسم:** <@${entry.userId}>\n`;
            bodyText += `▪️ **تفعيل شخص (آخر 7 أيام أو منذ آخر ترقية):** ${s.activationCount}\n`;
            bodyText += `▪️ **رفض شخص (آخر 7 أيام أو منذ آخر ترقية):** ${s.rejectionCount}\n`;
            bodyText += `▪️ **إعادة تفعيل شخص (آخر 7 أيام أو منذ آخر ترقية):** ${s.reactivationCount}\n`;
            bodyText += `▪️ **عدد ساعات الشخص:** ${formatSecondsToHoursText(s.totalHours)}\n`;
            bodyText += `▪️ **الدن :** ${s.doneCount}\n`;
            bodyText += `▪️ **التقييمات :** ${avgRatingStr} / 5 ${stars} (${s.ratingCount} تقييم)\n`;
            // إذا كانت المجموعة من نوع 'promotion' نضيف تاريخ الترقية
            if (group.type === 'promotion') {
              const promotionTimestamp = s.lastPromotion;
              if (promotionTimestamp) {
                bodyText += `▪️ **تاريخ آخر ترقية:** <t:${Math.floor(promotionTimestamp / 1000)}:F>\n`;
              } else {
                bodyText += `▪️ **تاريخ آخر ترقية:** لا يوجد\n`;
              }
            }
            bodyText += '\n';
            totalCount++;
          }
        }

        const header = `📊 جرد شامل (آخر 7 أيام للرتب العادية، ومنذ آخر ترقية للرتب المحددة)\n\n`;
        const footer = `\n**تم جرد ${totalCount} شخص.**`;

        const files = [];
        if (fs.existsSync(SERVER_LOGO_PATH)) {
          files.push(new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME }));
        }

        // تقسيم النص إذا تجاوز الحد
        const MAX_MSG_LENGTH = 2000;
        const fullText = header + bodyText + footer;

        if (fullText.length <= MAX_MSG_LENGTH) {
          await interaction.editReply({ content: fullText, files });
        } else {
          const parts = [];
          let currentPart = '';
          const lines = bodyText.split('\n');
          for (const line of lines) {
            const testPart = currentPart + line + '\n';
            const testFull = header + testPart + footer;
            if (testFull.length > MAX_MSG_LENGTH && currentPart.length > 0) {
              parts.push(currentPart);
              currentPart = '';
            }
            currentPart += (currentPart ? '\n' : '') + line;
          }
          if (currentPart) parts.push(currentPart);

          for (let i = 0; i < parts.length; i++) {
            let content;
            if (i === 0) {
              content = header + parts[i];
            } else if (i === parts.length - 1) {
              content = parts[i] + footer;
            } else {
              content = parts[i];
            }

            if (content.length > MAX_MSG_LENGTH) {
              const subParts = [];
              let sub = '';
              const subLines = content.split('\n');
              for (const sl of subLines) {
                if ((sub + sl + '\n').length > MAX_MSG_LENGTH) {
                  subParts.push(sub);
                  sub = '';
                }
                sub += (sub ? '\n' : '') + sl;
              }
              if (sub) subParts.push(sub);
              for (let j = 0; j < subParts.length; j++) {
                const subContent = (i === 0 && j === 0) ? header + subParts[j] : subParts[j];
                if (i === parts.length - 1 && j === subParts.length - 1) {
                  const finalContent = subContent + footer;
                  if (j === 0 && i === 0) {
                    await interaction.editReply({ content: finalContent, files });
                  } else {
                    await interaction.followUp({ content: finalContent });
                  }
                } else {
                  if (j === 0 && i === 0) {
                    await interaction.editReply({ content: subContent, files });
                  } else {
                    await interaction.followUp({ content: subContent });
                  }
                }
              }
              continue;
            }

            if (i === 0) {
              await interaction.editReply({ content: content, files });
            } else {
              await interaction.followUp({ content: content });
            }
          }
        }

        console.log(`✅ اكتمل الجرد المدمج: ${totalCount} شخص.`);
        return;
      }

      // /hm_panel
      if (interaction.commandName === 'hm_panel') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }

        const hmEmbed = new EmbedBuilder()
          .setTitle('HighMangment Login - Logout')
          .setDescription(`• Login : تسجيل دخول\n• Logout : تسجيل خروج`)
          .setColor(0x2b2d31)
          .setTimestamp();

        const hmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hm_check_in').setLabel('Login').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('hm_check_out').setLabel('Logout').setStyle(ButtonStyle.Danger)
        );

        const hmFiles = [];
        if (fs.existsSync(HM_BANNER_PATH)) {
          hmFiles.push(new AttachmentBuilder(HM_BANNER_PATH, { name: HM_BANNER_FILENAME }));
          hmEmbed.setImage(`attachment://${HM_BANNER_FILENAME}`);
        } else {
          console.warn(`⚠️ ملف البنر غير موجود: ${HM_BANNER_PATH}`);
        }
        if (fs.existsSync(SERVER_LOGO_PATH)) {
          hmFiles.push(new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME }));
          hmEmbed.setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`);
        } else {
          console.warn(`⚠️ ملف اللوقو غير موجود: ${SERVER_LOGO_PATH}`);
        }

        try {
          const hmChannel = await interaction.guild.channels.fetch(HM_PANEL_CHANNEL_ID);
          await hmChannel.send({ embeds: [hmEmbed], components: [hmRow], files: hmFiles });
          return interaction.reply({ content: `✅ تم إرسال لوحة تسجيل الدخول/الخروج إلى <#${HM_PANEL_CHANNEL_ID}>.`, ephemeral: true });
        } catch (err) {
          console.error('❌ خطأ في إرسال لوحة تسجيل الدخول/الخروج:', err);
          return interaction.reply({ content: '❌ حدث خطأ أثناء إرسال اللوحة. تأكد من صلاحيات البوت في الروم.', ephemeral: true });
        }
      }

      // /privacy
      if (interaction.commandName === 'privacy') {
        const privacyUrl = process.env.PRIVACY_POLICY_URL;

        if (privacyUrl) {
          const embed = new EmbedBuilder()
            .setTitle('🔒 سياسة الخصوصية')
            .setDescription(`يمكنك الاطلاع على سياسة الخصوصية الخاصة بنا من خلال الرابط التالي:\n[اضغط هنا لقراءة السياسة](${privacyUrl})`)
            .setColor(0x5865f2)
            .setTimestamp();
          
          return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
          return interaction.reply({ 
            content: '❌ عذراً، لم يتم تحديد رابط سياسة الخصوصية بعد. يرجى التواصل مع المطور.', 
            ephemeral: true 
          });
        }
      }

      // ===== أوامر التقارير =====
      if (interaction.commandName === 'censorship_report') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }
        await interaction.reply({ content: '🔄 جاري إرسال تقرير رومات الرقابة...', ephemeral: true });
        const guild = interaction.guild;
        await sendVoiceChannelReport(guild, CENSORSHIP_VOICE_CHANNELS, CENSORSHIP_REPORT_CHANNEL_ID, 'تقرير رومات الرقابة', 0xe74c3c);
        return;
      }

      if (interaction.commandName === 'activation_report') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }
        await interaction.reply({ content: '🔄 جاري إرسال تقرير رومات التفعيل...', ephemeral: true });
        const guild = interaction.guild;
        await sendVoiceChannelReport(guild, ACTIVATION_VOICE_CHANNELS, ACTIVATION_REPORT_CHANNEL_ID, 'تقرير رومات التفعيل', 0x2ecc71);
        return;
      }

      if (interaction.commandName === 'high_staff_report') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }
        await interaction.reply({ content: '🔄 جاري إرسال تقرير رومات الإدارة العليا...', ephemeral: true });
        const guild = interaction.guild;
        await sendVoiceChannelReport(guild, HIGH_STAFF_VOICE_CHANNELS, HIGH_STAFF_REPORT_CHANNEL_ID, 'تقرير رومات الإدارة العليا', 0x9b59b6);
        return;
      }

      // ===== أمر clear =====
      if (interaction.commandName === 'clear') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages) && !hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ ليس لديك صلاحية لاستخدام هذا الأمر.', flags: 64 });
        }

        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;
        const amount = interaction.options.getInteger('amount');

        if (!targetChannel.isTextBased()) {
          return interaction.reply({ content: '❌ يجب تحديد روم نصية فقط.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          let deletedCount = 0;

          if (amount) {
            const messages = await targetChannel.messages.fetch({ limit: amount });
            const deleted = await targetChannel.bulkDelete(messages, true);
            deletedCount = deleted.size;
          } else {
            let fetched;
            do {
              fetched = await targetChannel.messages.fetch({ limit: 100 });
              if (fetched.size > 0) {
                const deleted = await targetChannel.bulkDelete(fetched, true);
                deletedCount += deleted.size;
                if (deleted.size === 0) break;
              }
            } while (fetched.size >= 2);
          }

          return interaction.editReply({
            content: `✅ تم بنجاح حذف **${deletedCount}** رسالة من الروم ${targetChannel}.`
          });

        } catch (err) {
          console.error('❌ خطأ أثناء تنفيذ أمر clear:', err);
          return interaction.editReply({
            content: '⚠️ حدث خطأ أثناء تنفيذ عملية الحذف. قد تكون الرسائل أقدم من 14 يومًا ولا يمكن حذفها دفعة واحدة.'
          });
        }
      }

      // ===== أوامر التفعيل =====
      if (interaction.commandName === 'مفتوح') {
        const allowedRoleIds = ['1486588170282733700', '1524667894711980173'];
        const memberRoles = interaction.member.roles.cache.map(r => r.id);
        const hasPermission = allowedRoleIds.some(roleId => memberRoles.includes(roleId));
        if (!hasPermission) {
          return interaction.reply({ content: '❌ ليس لديك الصلاحية لاستخدام هذا الأمر.', ephemeral: true });
        }

        const targetChannelId = '1461735934499487754';
        const channel = interaction.guild.channels.cache.get(targetChannelId);
        if (!channel) {
          return interaction.reply({ content: '❌ القناة المحددة غير موجودة.', ephemeral: true });
        }

        const message = `**حالة التفعيل [مفتوح  <:z5:1470889445602365571>  ]**

https://discord.com/channels/1403099156016533557/1483285123008041031

***||@everyone||***`;

        try {
          await channel.send(message);
          return interaction.reply({ content: '✅ تم إرسال إشعار التفعيل المفتوح.', ephemeral: true });
        } catch (err) {
          console.error('❌ خطأ في إرسال رسالة /مفتوح:', err);
          return interaction.reply({ content: '❌ حدث خطأ أثناء إرسال الرسالة.', ephemeral: true });
        }
      }

      if (interaction.commandName === 'مغلق') {
        const allowedRoleIds = ['1486588170282733700', '1524667894711980173'];
        const memberRoles = interaction.member.roles.cache.map(r => r.id);
        const hasPermission = allowedRoleIds.some(roleId => memberRoles.includes(roleId));
        if (!hasPermission) {
          return interaction.reply({ content: '❌ ليس لديك الصلاحية لاستخدام هذا الأمر.', ephemeral: true });
        }

        const targetChannelId = '1461735934499487754';
        const channel = interaction.guild.channels.cache.get(targetChannelId);
        if (!channel) {
          return interaction.reply({ content: '❌ القناة المحددة غير موجودة.', ephemeral: true });
        }

        const message = `**حالة التفعيل [مغلق❌   ]**

https://discord.com/channels/1403099156016533557/1483285123008041031

***||@everyone||***`;

        try {
          await channel.send(message);
          return interaction.reply({ content: '✅ تم إرسال إشعار التفعيل المغلق.', ephemeral: true });
        } catch (err) {
          console.error('❌ خطأ في إرسال رسالة /مغلق:', err);
          return interaction.reply({ content: '❌ حدث خطأ أثناء إرسال الرسالة.', ephemeral: true });
        }
      }
    }
  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ.', ephemeral: true }).catch(() => null);
    } else if (interaction.deferred) {
      await interaction.editReply({ content: '❌ حدث خطأ أثناء تنفيذ الأمر.' }).catch(() => null);
    }
  }
});

app.listen(PORT, () => console.log(`🌐 سيرفر HTTP شغال على بورت ${PORT} (فحص Render فقط).`));

// ============================================================
// حفظ البيانات عند الإغلاق
// ============================================================
process.on('SIGINT', () => {
  console.log('🔄 حفظ البيانات...');
  saveActiveLeaves();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔄 حفظ البيانات...');
  saveActiveLeaves();
  process.exit(0);
});

client.login(BOT_TOKEN);
