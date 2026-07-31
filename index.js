require('dotenv').config();
const fs = require('fs');
const path = require('path');
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

// ===== قاعدة بيانات SQLite =====
const Database = require('better-sqlite3');
const db = new Database('data.db');

// ===== إنشاء الجداول =====
db.exec(`
  CREATE TABLE IF NOT EXISTS active_leaves (
    user_id TEXT PRIMARY KEY,
    end_date INTEGER
  );
  CREATE TABLE IF NOT EXISTS evaluated_sessions (
    session_id TEXT PRIMARY KEY
  );
`);

// ===== المتغيرات البيئية =====
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

// ===== رومات الانتظار الإضافية =====
const ADDITIONAL_WAITING_IDS = [
  '1481398869463138604',
  '1519511668823167116',
  '1483285123008041031'
];

const WAITING_CHANNEL_IDS = [
  ...WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean),
  ...ADDITIONAL_WAITING_IDS
];

// ===== خريطة روم الانتظار -> رومات الإدارة المخصصة =====
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

// ===== خريطة روم الانتظار -> الرتبة المطلوبة للإداري =====
const WAITING_ROOM_REQUIRED_ROLE = {
  '1483285123008041031': '1486587636863864862' // رتبة Activation Team
};

// ===== إعدادات عامة =====
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];

const WAITING_NOTIFICATION_CHANNEL_ID = '1530276832203636737';
const WAITING_MENTION_ROLE_ID = '1499102575918579793';
const WAITING_TIMEOUT_MS = 3 * 60 * 1000;

// ===== رومات الإدارة العامة (لرومات الانتظار غير المخصصة) =====
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

// ===== قناة التقييم =====
const RATING_CHANNEL_ID = '1531018869764788446';

// ===== روم الـ Done الصوتي =====
const DONE_VOICE_CHANNEL_ID = '1499086608010449089';

function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
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

// ===== تحميل البيانات =====
const activeLeaves = loadActiveLeaves();

// ===== دوال مساعدة =====
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

// ===== حالة الجلسات النشطة والكول داون =====
const activeSessions = new Map(); // citizenId -> { adminId, startTime }
const cooldownMap = new Map();   // `${adminId}_${citizenId}` -> timestamp (end of cooldown)
const waitingTimers = new Map(); // لإدارة تنبيه الانتظار

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
async function fetchMessages(channelId, days) {
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return [];
    const limit = 1000;
    const messages = [];
    let lastId = null;
    const until = Date.now() - days * 24 * 60 * 60 * 1000;
    let fetched = 0;
    while (fetched < limit) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const msgs = await channel.messages.fetch(options);
      if (msgs.size === 0) break;
      const filtered = msgs.filter(m => m.createdTimestamp >= until);
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
// دوال السحب التلقائي المباشر
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
  if (isDeafened(adminMember.voice)) return false;
  return true;
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
  if (WAITING_ROOM_ADMIN_MAP[waitingChannelId]) {
    targetAdminRoomIds = WAITING_ROOM_ADMIN_MAP[waitingChannelId];
  } else {
    targetAdminRoomIds = ADMIN_ROOM_IDS;
  }

  const requiredRoleId = WAITING_ROOM_REQUIRED_ROLE[waitingChannelId] || ADMIN_ROLE_ID;

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
    const key = `${adminMember.id}_${candidate.id}`;
    const cooldownEnd = cooldownMap.get(key);
    if (cooldownEnd && cooldownEnd > Date.now()) {
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
// تسجيل الأوامر
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
  try {
    const commands = [
      { name: 'send_leave_panel', description: 'إرسال لوحة طلبات الإجازات والاستقالات' },
      { name: 'active_leaves', description: 'عرض قائمة الإداريين المجازين' },
      { name: 'barren', description: 'جرد إحصائيات فريق التفعيل' }
    ];
    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تسجيل الأوامر.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

// ============================================================
// أحداث الصوت
// ============================================================
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
      await tryPullForAllFreeAdmins(guild);
    }
  }

  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    console.error('خطأ في السحب:', err);
  }
});

// ============================================================
// معالج التفاعلات (الإجازات + التقييم + barren)
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
        await requestsChannel.send({ embeds: [embed], components: [row] });
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
        await requestsChannel.send({ embeds: [embed], components: [row] });
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
        await requestsChannel.send({ embeds: [embed], components: [row] });
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

      // ===== الأمر الجديد: barren (جرد فريق التفعيل) =====
      if (interaction.commandName === 'barren') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة.', ephemeral: true });
        }

        await interaction.deferReply();

        const guild = interaction.guild;
        await guild.members.fetch();

        const targetRoleId = '1486587636863864862'; // Activation Team

        // قنوات الإحصائيات
        const activateChannel = '1484859915200626829';   // تفعيل شخص
        const rejectChannel = '1484865429158756494';     // رفض شخص
        const reactivateChannel = '1493565275428225125'; // إعادة تفعيل شخص

        // جلب الرسائل لآخر 7 أيام
        const days = 7;
        const [activateMsgs, rejectMsgs, reactivateMsgs] = await Promise.all([
          fetchMessages(activateChannel, days),
          fetchMessages(rejectChannel, days),
          fetchMessages(reactivateChannel, days)
        ]);

        // جلب أعضاء الرتبة
        const members = guild.members.cache.filter(m => m.roles.cache.has(targetRoleId));

        if (members.size === 0) {
          return interaction.editReply({ content: '❌ لا يوجد أعضاء في فريق التفعيل.' });
        }

        // حساب الإحصائيات لكل عضو
        const stats = [];
        for (const [id, member] of members) {
          // تفعيل: رسائل تحتوي على منشن العضو (مع تجاهل الكلمات لأنها مخصصة)
          const activates = activateMsgs.filter(msg => msg.content.includes(`<@${id}>`)).length;
          const rejects = rejectMsgs.filter(msg => msg.content.includes(`<@${id}>`)).length;
          const reactivates = reactivateMsgs.filter(msg => msg.content.includes(`<@${id}>`)).length;

          stats.push({
            member,
            activates,
            rejects,
            reactivates
          });
        }

        // ترتيب حسب عدد التفعيلات تنازلياً
        stats.sort((a, b) => b.activates - a.activates);

        // بناء الإمبـد
        const embed = new EmbedBuilder()
          .setTitle('📊 جرد فريق التفعيل')
          .setColor(0x5865f2)
          .setDescription(`**الفترة:** آخر ${days} يوم (من ${new Date(Date.now() - days*24*60*60*1000).toLocaleDateString('ar-SA')} إلى ${new Date().toLocaleDateString('ar-SA')})`)
          .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
          .setTimestamp();

        let description = '';
        for (const stat of stats) {
          const name = stat.member.displayName || stat.member.user.username;
          description += `**${name}**\n`;
          description += `<@&${targetRoleId}>\n`;
          description += `▪️ **تفعيل شخص:** ${stat.activates}\n`;
          description += `▪️ **رفض شخص:** ${stat.rejects}\n`;
          description += `▪️ **إعادة تفعيل شخص:** ${stat.reactivates}\n\n`;
        }

        // تقسيم النص الطويل إذا تجاوز الحد
        const MAX_DESC_LENGTH = 4000;
        if (description.length > MAX_DESC_LENGTH) {
          const parts = [];
          let currentPart = '';
          const lines = description.split('\n');
          for (const line of lines) {
            if (currentPart.length + line.length + 1 > MAX_DESC_LENGTH) {
              parts.push(currentPart);
              currentPart = '';
            }
            currentPart += (currentPart ? '\n' : '') + line;
          }
          if (currentPart) parts.push(currentPart);

          const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          const embed1 = EmbedBuilder.from(embed).setDescription(parts[0]);
          await interaction.editReply({ embeds: [embed1], files: [logoFile] });
          for (let i = 1; i < parts.length; i++) {
            const embedPart = EmbedBuilder.from(embed).setDescription(parts[i]);
            await interaction.followUp({ embeds: [embedPart] });
          }
        } else {
          embed.setDescription(description);
          const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
          await interaction.editReply({ embeds: [embed], files: [logoFile] });
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
