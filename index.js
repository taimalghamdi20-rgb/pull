const fs = require('fs');
const path = require('path');
const http = require('http');

// ===== سيرفر HTTP وهمي =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('✅ البوت شغال.');
}).listen(PORT, () => {
  console.log(`🌐 سيرفر HTTP الوهمي شغال على بورت ${PORT}`);
});

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
} = require('discord.js');

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

const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
} = process.env;

if (!BOT_TOKEN || BOT_TOKEN.trim() === '') {
  console.error('❌ خطأ: BOT_TOKEN غير موجود أو فارغ.');
  process.exit(1);
}
if (!GUILD_ID || GUILD_ID.trim() === '') {
  console.error('❌ خطأ: GUILD_ID غير موجود.');
  process.exit(1);
}
if (!WAITING_CHANNEL_ID || WAITING_CHANNEL_ID.trim() === '') {
  console.error('❌ خطأ: WAITING_CHANNEL_ID غير موجود.');
  process.exit(1);
}
if (!ADMIN_ROLE_ID || ADMIN_ROLE_ID.trim() === '') {
  console.error('❌ خطأ: ADMIN_ROLE_ID غير موجود.');
  process.exit(1);
}

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
    '1499105265272754246',
    '1499105221383819497',
    '1499105170716491806',
    '1525972362246226041',
    '1499105092933128212',
    '1499084679083720805',
    '1499352796435058848',
    '1499352980120403989',
    '1499353050907938916'
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
  '1533115980241305860'
];
const SPECIAL_REQUIRED_ADMIN_ROLE_ID = '1499102575918579793';

const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];

const LEAVE_REQUEST_MENTION_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];

const WAITING_NOTIFICATION_CHANNEL_ID = '1530276832203636737';
const WAITING_MENTION_ROLE_ID = '1499102575918579793';
const WAITING_TIMEOUT_MS = 3 * 60 * 1000;

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

const ALLOWED_ROLE_IDS = [
  '1499162553245499432',
  '1480102405931667467',
  '1472332996269838490',
  '1472333499221544981',
  '1472333861965791374',
  '1472342890058354801',
  '1480102742851850302',
  '1472353378695778537',
  '1459304443844497633',
  '1472352421153083563',
  '1459304436491882742'
];

function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

function hasBarrenRole(member) {
  return member.roles.cache.has(BARREN_ROLE_ID);
}

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

async function fetchAllMessages(channelId, limit = 500) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return [];
  const messages = [];
  let lastId = null;
  let fetched = 0;
  while (fetched < limit) {
    const options = { limit: Math.min(100, limit - fetched) };
    if (lastId) options.before = lastId;
    const msgs = await channel.messages.fetch(options);
    if (msgs.size === 0) break;
    messages.push(...msgs.values());
    lastId = msgs.last().id;
    fetched += msgs.size;
    if (msgs.size < 100) break;
  }
  return messages;
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

client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;
    const isAdmin = message.member && hasStaffRole(message.member);
    if (!isAdmin) {
      try { await message.delete(); } catch (err) { /* ignore */ }
    }
  }
});

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
  if (!guild || !client) return;

  const waitingData = getNextEligibleWaitingMember(guild);
  if (!waitingData) return;

  const { member: candidate, waitingChannelId } = waitingData;

  let targetAdminRoomIds;
  let requiredRoleId;

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
    if (adminCooldownEnd && adminCooldownEnd > Date.now()) {
      return false;
    }
    const pairKey = `${adminMember.id}_${candidate.id}`;
    const pairCooldownEnd = cooldownMap.get(pairKey);
    if (pairCooldownEnd && pairCooldownEnd > Date.now()) {
      return false;
    }
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
    if (err.message && err.message.includes('token')) {
      console.warn('⚠️ تجاهل خطأ سحب بسبب مشكلة توكن');
    } else {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    }
  }
}

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

client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
  try {
    const commands = [
      { name: 'send_leave_panel', description: 'إرسال لوحة طلبات الإجازات والاستقالات' },
      { name: 'active_leaves', description: 'عرض قائمة الإداريين المجازين' },
      { name: 'barren', description: 'جرد إحصائيات فريق التفعيل' },
      { name: 'privacy', description: 'عرض سياسة الخصوصية الخاصة بالبوت' }
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;
  const userId = newState.id;

  const session = activeSessions.get(userId);
  if (session) {
    const adminId = session.adminId;
    const adminMember = await guild.members.fetch(adminId).catch(() => null);
    if (!adminMember) {
      await endSession(guild, userId, adminId, session.startTime);
      return;
    }

    const adminVoice = adminMember.voice;
    const citizenVoice = newState;

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

  const enteredWaiting = WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId);
  const leftWaiting = WAITING_CHANNEL_IDS.includes(oldState.channelId) && !WAITING_CHANNEL_IDS.includes(newState.channelId);

  if (enteredWaiting) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !hasStaffRole(member)) {
      const oldEntry = waitingTimers.get(userId);
      if (oldEntry) clearTimeout(oldEntry.timeout);

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
          if (err.message && err.message.includes('token')) {
            console.warn('⚠️ تجاهل خطأ تنبيه الانتظار بسبب مشكلة توكن');
          } else {
            console.error('❌ خطأ في تنبيه الانتظار:', err);
          }
        }
      }, WAITING_TIMEOUT_MS);

      waitingTimers.set(userId, { timeout: timer, channelId: newState.channelId, sent: false });
    }
  }

  if (leftWaiting) {
    const entry = waitingTimers.get(userId);
    if (entry) {
      clearTimeout(entry.timeout);
      waitingTimers.delete(userId);
    }
  }

  const enteredWaitingOriginal = WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId);
  if (enteredWaitingOriginal) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !hasStaffRole(member)) {
      try {
        await tryPullForAllFreeAdmins(guild);
      } catch (err) {
        if (err.message && err.message.includes('token')) {
          console.warn('⚠️ تجاهل خطأ سحب (enteredWaiting) بسبب مشكلة توكن');
        } else {
          console.error('❌ خطأ في السحب (enteredWaiting):', err);
        }
      }
    }
  }

  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    if (err.message && err.message.includes('token')) {
      console.warn('⚠️ تجاهل خطأ سحب عام بسبب مشكلة توكن');
    } else {
      console.error('خطأ في السحب:', err);
    }
  }
});

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
          const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
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
          await channel.send({ embeds: [embed], files: [logoFile] });
        }
      } catch (e) {
        console.error('❌ خطأ في إرسال التقييم إلى القناة:', e);
      }

      return;
    }

    // ===== باقي الأزرار (الإجازات) =====
    if (interaction.isButton()) {
      // طلب إجازة
      if (interaction.customId === 'open_leave_modal') {
        try {
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
        } catch (err) {
          console.error('❌ فشل عرض مودال الإجازة:', err);
          await interaction.reply({ content: '❌ حدث خطأ أثناء فتح نموذج الإجازة، حاول مجدداً.', ephemeral: true }).catch(() => null);
        }
        return;
      }

      // طلب استقالة
      if (interaction.customId === 'open_resign_modal') {
        try {
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
        } catch (err) {
          console.error('❌ فشل عرض مودال الاستقالة:', err);
          await interaction.reply({ content: '❌ حدث خطأ أثناء فتح نموذج الاستقالة، حاول مجدداً.', ephemeral: true }).catch(() => null);
        }
        return;
      }

      // طلب كسر إجازة
      if (interaction.customId === 'open_break_modal') {
        try {
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
        } catch (err) {
          console.error('❌ فشل عرض مودال كسر الإجازة:', err);
          await interaction.reply({ content: '❌ حدث خطأ أثناء فتح نموذج كسر الإجازة، حاول مجدداً.', ephemeral: true }).catch(() => null);
        }
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
          try {
            const target = await interaction.guild.members.fetch(requesterId);
            if (reqType === 'leave') {
              await target.roles.add(LEAVE_ROLE_ID);
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
              await target.roles.set([RESIGNATION_KEEP_ROLE_ID]);
              try {
                await target.setNickname(null, 'تم قبول الاستقالة - حذف النيك نيم');
              } catch (nickErr) {
                console.error('⚠️ فشل حذف النيك نيم:', nickErr);
              }
            } else if (reqType === 'break') {
              if (target.roles.cache.has(LEAVE_ROLE_ID)) {
                await target.roles.remove(LEAVE_ROLE_ID);
              }
              if (activeLeaves.has(requesterId)) {
                activeLeaves.delete(requesterId);
                saveActiveLeaves();
              }
            }
          } catch (e) { console.error('⚠️ خطأ في تعديل الرتب:', e); }
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
      if (interaction.commandName === 'send_leave_panel') {
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
          .setImage(`attachment://${LEAVE_BANNER_FILENAME}`)
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('open_leave_modal').setLabel('طلب إجازة').setEmoji('📄').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('open_break_modal').setLabel('كسر إجازة').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('open_resign_modal').setLabel('استقالة').setEmoji('📝').setStyle(ButtonStyle.Danger)
        );
        const file = new AttachmentBuilder(LEAVE_BANNER_PATH, { name: LEAVE_BANNER_FILENAME });
        const channel = await interaction.guild.channels.fetch(LEAVE_EMBED_CHANNEL_ID);
        await channel.send({ embeds: [panelEmbed], components: [row], files: [file] });
        return interaction.reply({ content: `✅ تم إرسال اللوحة إلى <#${LEAVE_EMBED_CHANNEL_ID}>.`, ephemeral: true });
      }

      // ===== الأمر active_leaves =====
      if (interaction.commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const leaveRoleId = LEAVE_ROLE_ID;
        let membersWithLeave;
        try {
          membersWithLeave = await interaction.guild.members.fetch({ role: leaveRoleId });
        } catch (err) {
          console.error('❌ فشل جلب الأعضاء بالرتبة:', err);
          return interaction.editReply({ content: '❌ حدث خطأ أثناء جلب الأعضاء.' });
        }

        if (membersWithLeave.size === 0) {
          return interaction.editReply({ content: '🌴 لا يوجد أعضاء لديهم رتبة الإجازة حالياً.' });
        }

        let messages = [];
        try {
          messages = await fetchAllMessages(LEAVE_PANEL_CHANNEL_ID, 500);
        } catch (err) {
          console.error('❌ فشل جلب رسائل القناة:', err);
          return interaction.editReply({ content: '❌ حدث خطأ أثناء جلب رسائل القناة.' });
        }

        const acceptedLeaveMap = new Map();
        for (const msg of messages) {
          if (msg.embeds.length === 0) continue;
          const embed = msg.embeds[0];
          if (!embed.title || !embed.title.includes('طلب إجازة')) continue;
          const fields = embed.fields || [];
          const statusField = fields.find(f => f.name.includes('الحالة'));
          if (!statusField || !statusField.value.includes('تم القبول')) continue;
          const description = embed.description || '';
          const match = description.match(/<@!?(\d+)>/);
          if (!match) continue;
          const userId = match[1];
          const durationField = fields.find(f => f.name.includes('المدة'));
          if (!durationField) continue;
          const durationMatch = durationField.value.match(/\d+/);
          if (!durationMatch) continue;
          const days = parseInt(durationMatch[0]);
          const existing = acceptedLeaveMap.get(userId);
          if (!existing || msg.createdTimestamp > existing.acceptedTimestamp) {
            acceptedLeaveMap.set(userId, {
              durationDays: days,
              acceptedTimestamp: msg.createdTimestamp
            });
          }
        }

        let lines = [];
        let index = 1;
        let anyActive = false;
        for (const [userId, member] of membersWithLeave) {
          const leaveInfo = acceptedLeaveMap.get(userId);
          let statusText = '';
          if (leaveInfo) {
            const endDate = leaveInfo.acceptedTimestamp + (leaveInfo.durationDays * 24 * 60 * 60 * 1000);
            const remaining = endDate - Date.now();
            if (remaining <= 0) {
              statusText = '✅ انتهت';
            } else {
              const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
              const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
              statusText = `⏳ متبقي: ${days} يوم و ${hours} ساعة`;
              anyActive = true;
            }
          } else {
            statusText = '❓ غير مسجل (لا يوجد طلب إجازة مقبول)';
          }
          lines.push(`**${index}.** <@${userId}> — ${statusText}`);
          index++;
        }

        if (lines.length === 0) {
          return interaction.editReply({ content: 'لا توجد بيانات.' });
        }

        if (!anyActive) {
          lines.push('\n⚠️ جميع الإجازات منتهية أو غير مسجلة.');
        }

        const header = '📋 قائمة الإجازات النشطة (حسب الرتبة)\n\n';
        const fullText = header + lines.join('\n');

        const MAX_LENGTH = 2000;
        let parts = [];
        let currentPart = '';
        const allLines = fullText.split('\n');
        for (const line of allLines) {
          if ((currentPart + line + '\n').length > MAX_LENGTH) {
            parts.push(currentPart);
            currentPart = '';
          }
          currentPart += (currentPart ? '\n' : '') + line;
        }
        if (currentPart) parts.push(currentPart);

        await interaction.editReply({ content: parts[0] });
        for (let i = 1; i < parts.length; i++) {
          await interaction.followUp({ content: parts[i] });
        }
        return;
      }

      // ===== أمر barren =====
      if (interaction.commandName === 'barren') {
        if (!hasBarrenRole(interaction.member)) {
          return interaction.reply({ 
            content: '❌ هذا الأمر مخصص لأعضاء رتبة محددة فقط.', 
            ephemeral: true 
          });
        }

        await interaction.deferReply();

        const guild = interaction.guild;
        
        console.log('==================== بدء جرد فريق التفعيل ====================');
        console.log('🔄 جاري جلب جميع أعضاء السيرفر...');
        await guild.members.fetch({ withPresences: false, force: true });
        console.log(`✅ تم جلب ${guild.members.cache.size} عضو.`);

        const targetRoleId = '1486587636863864862';
        console.log(`🎯 الرتبة المستهدفة: ${targetRoleId}`);

        const role = guild.roles.cache.get(targetRoleId);
        if (!role) {
          console.log('❌ الرتبة غير موجودة!');
          return interaction.editReply({ content: '❌ الرتبة غير موجودة.' });
        }
        console.log(`✅ تم العثور على الرتبة: "${role.name}" (${role.id})`);

        const members = role.members;
        console.log(`📊 عدد الأعضاء في role.members: ${members.size}`);

        if (members.size === 0) {
          return interaction.editReply({ content: '❌ لا يوجد أعضاء في فريق التفعيل.' });
        }

        console.log('🔄 جاري جلب تواريخ آخر ترقية لكل إداري من قناة الترقيات...');
        const lastPromotionMap = await getLastPromotionDate(guild);
        console.log(`✅ تم جلب تواريخ الترقية لـ ${lastPromotionMap.size} إداري.`);

        const activateChannel = '1484859915200626829';
        const rejectChannel = '1484865429158756494';
        const reactivateChannel = '1493565275428225125';

        const days = 30;
        const [activateMsgs, rejectMsgs, reactivateMsgs] = await Promise.all([
          fetchMessagesFromDate(activateChannel, Date.now() - days * 24 * 60 * 60 * 1000),
          fetchMessagesFromDate(rejectChannel, Date.now() - days * 24 * 60 * 60 * 1000),
          fetchMessagesFromDate(reactivateChannel, Date.now() - days * 24 * 60 * 60 * 1000)
        ]);

        console.log(`📊 عدد رسائل التفعيل: ${activateMsgs.length}`);
        console.log(`📊 عدد رسائل الرفض: ${rejectMsgs.length}`);
        console.log(`📊 عدد رسائل إعادة التفعيل: ${reactivateMsgs.length}`);

        const stats = [];
        for (const [id, member] of members) {
          const promotionDate = lastPromotionMap.get(id) || Date.now() - 7 * 24 * 60 * 60 * 1000;
          console.log(`   ⏰ ${member.user.tag} آخر ترقية: ${new Date(promotionDate).toLocaleDateString('ar-SA')}`);

          const activates = activateMsgs.filter(msg => 
            msg.createdTimestamp >= promotionDate && msg.content.includes(`<@${id}>`)
          ).length;
          const rejects = rejectMsgs.filter(msg => 
            msg.createdTimestamp >= promotionDate && msg.content.includes(`<@${id}>`)
          ).length;
          const reactivates = reactivateMsgs.filter(msg => 
            msg.createdTimestamp >= promotionDate && msg.content.includes(`<@${id}>`)
          ).length;

          const roleMentions = ALLOWED_ROLE_IDS
            .filter(roleId => member.roles.cache.has(roleId))
            .map(roleId => `<@&${roleId}>`)
            .join(' ') || 'لا يوجد رتبة';

          stats.push({ 
            member, 
            activates, 
            rejects, 
            reactivates, 
            roleMentions,
            promotionDate 
          });
        }

        stats.sort((a, b) => b.activates - a.activates);

        let bodyText = '';
        for (const stat of stats) {
          const promotionDateStr = new Date(stat.promotionDate).toLocaleDateString('ar-SA');
          bodyText += `<@${stat.member.id}>\n`;
          bodyText += `**الرتب:** ${stat.roleMentions}\n`;
          bodyText += `▪️ **تفعيل شخص:** ${stat.activates}\n`;
          bodyText += `▪️ **رفض شخص:** ${stat.rejects}\n`;
          bodyText += `▪️ **إعادة تفعيل شخص:** ${stat.reactivates}\n`;
          bodyText += `▪️ **آخر ترقية:** ${promotionDateStr}\n\n`;
        }

        const totalCount = stats.length;

        const header = `📊 جرد فريق التفعيل (منذ آخر ترقية لكل عضو)\n\n`;
        const footer = `\n**تم جرد ${totalCount} شخص.**`;

        const MAX_MSG_LENGTH = 2000;
        const fullText = header + bodyText + footer;

        if (fullText.length <= MAX_MSG_LENGTH) {
          const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          await interaction.editReply({ content: fullText, files: [logoFile] });
          console.log('✅ تم إرسال النص كاملاً.');
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

          console.log(`📊 عدد الأجزاء: ${parts.length}`);

          const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });

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
                    await interaction.editReply({ content: finalContent, files: [logoFile] });
                  } else {
                    await interaction.followUp({ content: finalContent });
                  }
                } else {
                  if (j === 0 && i === 0) {
                    await interaction.editReply({ content: subContent, files: [logoFile] });
                  } else {
                    await interaction.followUp({ content: subContent });
                  }
                }
              }
              continue;
            }

            if (i === 0) {
              await interaction.editReply({ content: content, files: [logoFile] });
            } else {
              await interaction.followUp({ content: content });
            }
            console.log(`✅ تم إرسال الجزء ${i+1}`);
          }
          console.log('✅ تم إرسال جميع الأجزاء بنجاح.');
        }

        console.log(`✅ اكتمل الجرد: ${totalCount} شخص.`);
        console.log('==============================================================\n');
      }

      // أمر privacy
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
    }
  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    // إذا كان التفاعل منتهي الصلاحية، لا نحاول الرد
    if (error.code === 10062) {
      console.warn('⏳ تفاعل منتهي الصلاحية (10062)');
      return;
    }
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى.', ephemeral: true }).catch(() => null);
    } else if (interaction.deferred) {
      await interaction.editReply({ content: '❌ حدث خطأ أثناء تنفيذ الأمر.' }).catch(() => null);
    }
  }
});

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

client.login(BOT_TOKEN.trim()).catch(err => {
  console.error('❌ فشل تسجيل الدخول:', err);
  process.exit(1);
});
