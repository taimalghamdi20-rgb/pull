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
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');

// ===== قاعدة بيانات SQLite =====
const Database = require('better-sqlite3');
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS done_counts (
    admin_id TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS active_leaves (
    user_id TEXT PRIMARY KEY,
    end_date INTEGER
  );
  CREATE TABLE IF NOT EXISTS evaluated_logs (
    log_id TEXT PRIMARY KEY
  );
`);

// ===== المتغيرات البيئية =====
const {
  BOT_TOKEN,
  GUILD_ID,
  WAITING_CHANNEL_ID,
  ADMIN_ROLE_ID,
  ADMIN_CATEGORY_ID,
  CITIZEN_ROLE_ID,
  DONE_VOICE_CHANNEL_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== إضافة رومات الانتظار الجديدة =====
const ADDITIONAL_WAITING_IDS = [
  '1481398869463138604',
  '1519511668823167116'
];

const WAITING_CHANNEL_IDS = [
  ...WAITING_CHANNEL_ID.split(',').map(id => id.trim()).filter(Boolean),
  ...ADDITIONAL_WAITING_IDS
];

// ===== إعدادات عامة =====
const RATING_CHANNEL_ID = '1529482677516898555';
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178';
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714';
const LEAVE_ROLE_ID = '1459304469127758027';
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428';
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481'];
const DONE_TEXT_CHANNEL_ID = '1529933848144510976';

// ✅ روم الـ Done الصوتي لنقل المواطن إليه عند إنهاء الجلسة
const DONE_VOICE_CHANNEL_ID_FOR_MOVE = '1499086608010449089';

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

function hasStaffRole(member) {
  return STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

// ===== دوال قاعدة البيانات =====
function loadDoneCounts() {
  const stmt = db.prepare('SELECT admin_id, count FROM done_counts');
  const rows = stmt.all();
  const map = new Map();
  for (const row of rows) map.set(row.admin_id, row.count);
  return map;
}

function saveDoneCounts() {
  db.prepare('DELETE FROM done_counts').run();
  const insert = db.prepare('INSERT INTO done_counts (admin_id, count) VALUES (?, ?)');
  const trans = db.transaction((entries) => {
    for (const [id, count] of entries) insert.run(id, count);
  });
  trans(doneCounts.entries());
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

// دوال التقييم المكرر
function isLogEvaluated(logId) {
  const stmt = db.prepare('SELECT log_id FROM evaluated_logs WHERE log_id = ?');
  return stmt.get(logId) !== undefined;
}

function markLogEvaluated(logId) {
  const stmt = db.prepare('INSERT OR IGNORE INTO evaluated_logs (log_id) VALUES (?)');
  stmt.run(logId);
}

// تحميل البيانات
const doneCounts = loadDoneCounts();
const activeLeaves = loadActiveLeaves();

// ===== دوال مساعدة =====
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

const pullLocks = new Set();
const activeSessions = new Map(); // citizenId -> { adminId, startTime, message, status, pendingAdmins, messages }

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
// دوال السحب
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
      return member;
    }
  }
  return null;
}

function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2) return false;
  if (!ADMIN_ROOM_IDS.includes(channel.id)) return false;
  const members = [...channel.members.values()];
  if (members.length !== 1) return false;
  const adminMember = members[0];
  if (!adminMember.roles.cache.has(ADMIN_ROLE_ID)) return false;
  if (isDeafened(adminMember.voice)) return false;
  return true;
}

// ============================================================
// دوال الجلسة (القبول، الرفض، الإنهاء، الإشعارات)
// ============================================================
async function sendCitizenNotification(citizenUser, adminUser) {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎙️ استعد لجلسة الدعم')
      .setDescription(`سيتم نقلك إلى روم الدعم (Support) بعد لحظات مع المسؤول\n${adminUser}`)
      .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
      .setFooter({ text: 'جهز ملاحظاتك وأسئلتك قبل بدء الجلسة' })
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

async function sendSessionRequest(guild, citizen, admin) {
  const doneChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
  if (!doneChannel) return null;

  const embed = new EmbedBuilder()
    .setColor(0xf1a10c)
    .setTitle('📩 طلب دعم جديد')
    .setDescription(`يوجد مواطن ينتظر الدعم.`)
    .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
    .addFields(
      { name: 'اللاعب', value: `${citizen}`, inline: true },
      { name: 'الإداري', value: `${admin}`, inline: true },
      { name: 'الوقت', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: false },
      { name: 'الحالة', value: '⏳ في انتظار القبول', inline: false }
    )
    .setFooter({ text: 'نظام الدعم الصوتي', iconURL: 'attachment://server_logo.png' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_session_${citizen.id}_${admin.id}`)
      .setLabel('✅ قبول')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_session_${citizen.id}_${admin.id}`)
      .setLabel('❌ رفض')
      .setStyle(ButtonStyle.Danger)
  );

  let logoFile = null;
  try {
    if (fs.existsSync(SERVER_LOGO_PATH)) {
      logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
    }
  } catch (e) {}

  const message = await doneChannel.send({
    embeds: [embed],
    components: [row],
    files: logoFile ? [logoFile] : []
  });

  return message;
}

async function acceptSession(guild, citizenId, adminId, message) {
  const session = activeSessions.get(citizenId);
  if (!session) {
    return { success: false, reason: 'الجلسة غير موجودة' };
  }

  if (session.status !== 'pending') {
    return { success: false, reason: 'الجلسة لم تعد معلقة' };
  }

  if (!session.pendingAdmins.includes(adminId)) {
    return { success: false, reason: 'الإداري ليس في قائمة المعلقين' };
  }

  session.status = 'accepted';
  session.startTime = Date.now();
  session.adminId = adminId;

  const embed = EmbedBuilder.from(message.embeds[0]);
  embed.setColor(0x2ecc71);
  embed.spliceFields(3, 1, { name: 'الحالة', value: '✅ تم القبول - جلسة نشطة', inline: false });
  embed.setFooter({ text: 'جلسة نشطة', iconURL: 'attachment://server_logo.png' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`end_session_${citizenId}_${adminId}`)
      .setLabel('🔴 إنهاء الجلسة')
      .setStyle(ButtonStyle.Danger)
  );

  await message.edit({ embeds: [embed], components: [row] });

  try {
    const citizenUser = await client.users.fetch(citizenId);
    const embedNotify = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ تم قبول طلبك')
      .setDescription(`تم قبول طلب الدعم الخاص بك بواسطة <@${adminId}>.\nسيتم نقلك إلى روم الدعم قريباً.`)
      .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
      .setTimestamp();
    let logoFile = null;
    try {
      if (fs.existsSync(SERVER_LOGO_PATH)) {
        logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });
      }
    } catch (e) {}
    await citizenUser.send({ embeds: [embedNotify], files: logoFile ? [logoFile] : [] });
  } catch (err) {
    console.error('❌ تعذر إرسال رسالة القبول للمواطن:', err);
  }

  for (const [otherAdminId, otherMessage] of Object.entries(session.messages || {})) {
    if (otherAdminId === adminId) continue;
    try {
      const otherEmbed = EmbedBuilder.from(otherMessage.embeds[0]);
      otherEmbed.setColor(0x95a5a6);
      otherEmbed.spliceFields(3, 1, { name: 'الحالة', value: '✅ تم القبول بواسطة إداري آخر', inline: false });
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('disabled')
          .setLabel('تم القبول من قبل آخر')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
      await otherMessage.edit({ embeds: [otherEmbed], components: [disabledRow] });
    } catch (e) { /* ignore */ }
  }

  return { success: true };
}

async function rejectSession(guild, citizenId, adminId, message) {
  const session = activeSessions.get(citizenId);
  if (!session) {
    return { success: false, reason: 'الجلسة غير موجودة' };
  }

  if (session.status !== 'pending') {
    return { success: false, reason: 'الجلسة لم تعد معلقة' };
  }

  if (!session.pendingAdmins.includes(adminId)) {
    return { success: false, reason: 'الإداري ليس في قائمة المعلقين' };
  }

  const embed = EmbedBuilder.from(message.embeds[0]);
  embed.setColor(0xe74c3c);
  embed.spliceFields(3, 1, { name: 'الحالة', value: '❌ تم الرفض بواسطة الإداري', inline: false });
  embed.setFooter({ text: 'تم رفض الجلسة', iconURL: 'attachment://server_logo.png' });

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('disabled')
      .setLabel('تم الرفض')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await message.edit({ embeds: [embed], components: [disabledRow] });

  session.pendingAdmins = session.pendingAdmins.filter(id => id !== adminId);
  delete session.messages[adminId];

  if (session.pendingAdmins.length === 0) {
    try {
      const citizenUser = await client.users.fetch(citizenId);
      await citizenUser.send('❌ جميع الإداريين المتاحين رفضوا طلبك. سيتم إعادة توجيهك للانتظار.');
    } catch (err) {}
    activeSessions.delete(citizenId);
  }

  return { success: true };
}

// ============================================================
// ✅ دالة إنهاء الجلسة (مع نقل المواطن إلى روم الـ Done الصوتي)
// ============================================================
async function endSession(guild, citizenId, adminId, startTime, message) {
  const durationSec = Math.floor((Date.now() - startTime) / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  const durationText = minutes > 0 ? `${minutes} دقيقة و ${seconds} ثانية` : `${seconds} ثانية`;

  const currentCount = (doneCounts.get(adminId) || 0) + 1;
  doneCounts.set(adminId, currentCount);
  saveDoneCounts();

  const embed = EmbedBuilder.from(message.embeds[0]);
  embed.setColor(0x57f287);
  embed.spliceFields(3, 1, { name: 'الحالة', value: '✅ تم الانتهاء', inline: false });
  embed.addFields(
    { name: '⏱️ مدة الخدمة', value: `\`${durationText}\``, inline: true },
    { name: '📊 مجموع الـ Done', value: `\`${currentCount}\``, inline: true }
  );
  embed.setFooter({ text: 'تم إنهاء الجلسة', iconURL: 'attachment://server_logo.png' });

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('disabled')
      .setLabel('تم الإنتهاء')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await message.edit({ embeds: [embed], components: [disabledRow] });

  // ✅ نقل المواطن إلى روم الـ Done الصوتي
  try {
    const citizenMember = await guild.members.fetch(citizenId);
    const doneVoiceChannel = guild.channels.cache.get(DONE_VOICE_CHANNEL_ID_FOR_MOVE);
    if (doneVoiceChannel && citizenMember.voice.channel) {
      await citizenMember.voice.setChannel(doneVoiceChannel.id, 'إنهاء الجلسة - نقل إلى روم الـ Done');
      console.log(`✅ تم نقل ${citizenMember.user.tag} إلى روم الـ Done الصوتي`);
    } else if (!doneVoiceChannel) {
      console.warn(`⚠️ روم الـ Done الصوتي (${DONE_VOICE_CHANNEL_ID_FOR_MOVE}) غير موجود`);
    }
  } catch (err) {
    console.error('⚠️ فشل نقل المواطن إلى روم الـ Done:', err);
  }

  try {
    const citizenUser = await client.users.fetch(citizenId);
    const logMsgId = message.id;
    const row = new ActionRowBuilder().addComponents(
      [1,2,3,4,5].map(r => new ButtonBuilder()
        .setCustomId(`rate_${r}_${adminId}_${logMsgId}`)
        .setLabel(`${r}⭐`)
        .setStyle(r === 5 ? ButtonStyle.Success : ButtonStyle.Secondary))
    );
    const dmEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📝 تقييم الخدمة')
      .setDescription(`تم الانتهاء من خدمتك بواسطة <@${adminId}> في مدة ${durationText}.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`)
      .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`);
    await citizenUser.send({ embeds: [dmEmbed], components: [row] });
  } catch (err) {
    console.error('⚠️ تعذر إرسال رسالة التقييم:', err);
  }

  activeSessions.delete(citizenId);
}

// ============================================================
// نظام السحب التلقائي (المعدل) - إرسال طلب لكل الإداريين الفاضيين
// ============================================================
async function tryPullForAllFreeAdmins(guild) {
  const freeAdmins = [];
  for (const roomId of ADMIN_ROOM_IDS) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel) continue;
    if (!isFreeAdminRoom(channel)) continue;
    const adminMember = channel.members.first();
    freeAdmins.push({ channel, adminMember });
  }

  if (freeAdmins.length === 0) return;

  const candidate = getNextEligibleWaitingMember(guild);
  if (!candidate) return;

  if (activeSessions.has(candidate.id)) return;

  if (pullLocks.has(candidate.id)) return;
  pullLocks.add(candidate.id);

  try {
    await sendCitizenNotification(candidate.user, freeAdmins[0].adminMember.user);

    const pendingAdmins = freeAdmins.map(fa => fa.adminMember.id);
    activeSessions.set(candidate.id, {
      adminId: null,
      startTime: null,
      message: null,
      status: 'pending',
      pendingAdmins: pendingAdmins,
      messages: {}
    });

    for (const { channel, adminMember } of freeAdmins) {
      const message = await sendSessionRequest(guild, candidate.user, adminMember.user);
      if (message) {
        activeSessions.get(candidate.id).messages[adminMember.id] = message;
      }
    }

    console.log(`📨 تم إرسال طلبات دعم لـ ${candidate.user.tag} إلى ${freeAdmins.length} إداري`);

  } catch (err) {
    console.error(`⚠️ فشل إرسال طلبات الدعم لـ ${candidate.user.tag}:`, err.message);
  } finally {
    pullLocks.delete(candidate.id);
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
      { name: 'top_done', description: 'عرض أكثر 10 إداريين إنجازاً' },
      { name: 'all_dones', description: 'عرض إحصائيات جميع الإداريين' },
      { 
        name: 'add_done', 
        description: 'إضافة عدد من الـ Done لإداري', 
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للإضافة', type: 4, required: true }
        ] 
      },
      { 
        name: 'remove_done', 
        description: 'خصم عدد من الـ Done من إداري', 
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للخصم', type: 4, required: true }
        ] 
      },
      { name: 'reset_all', description: 'تصفير جميع إحصائيات الـ Done' }
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

  if (session && session.status === 'accepted') {
    const wasInAdminRoom = oldState.channelId && ADMIN_ROOM_IDS.includes(oldState.channelId);
    const isInAdminRoom = newState.channelId && ADMIN_ROOM_IDS.includes(newState.channelId);
    
    if (wasInAdminRoom && !isInAdminRoom) {
      const adminId = session.adminId;
      const message = session.messages ? session.messages[adminId] : null;
      if (message) {
        await endSession(guild, userId, adminId, session.startTime, message);
      }
      activeSessions.delete(userId);
    }
  }

  const enteredWaiting = WAITING_CHANNEL_IDS.includes(newState.channelId) && !WAITING_CHANNEL_IDS.includes(oldState.channelId);
  if (enteredWaiting) {
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
// معالج التفاعلات (الكامل)
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      // ===== أزرار الجلسة =====
      if (interaction.customId && interaction.customId.startsWith('accept_session_')) {
        const parts = interaction.customId.split('_');
        const citizenId = parts[2];
        const adminId = parts[3];

        if (interaction.user.id !== adminId) {
          return interaction.reply({
            content: '❌ هذا الزر مخصص لإداري آخر، لا يمكنك قبول هذه الجلسة.',
            ephemeral: true
          });
        }

        const session = activeSessions.get(citizenId);
        if (!session) {
          return interaction.reply({ content: '⚠️ هذه الجلسة غير موجودة.', ephemeral: true });
        }
        if (session.status !== 'pending') {
          return interaction.reply({ content: '⚠️ هذه الجلسة لم تعد معلقة.', ephemeral: true });
        }
        if (!session.pendingAdmins.includes(adminId)) {
          return interaction.reply({ content: '⚠️ هذا الطلب لم يعد متاحاً.', ephemeral: true });
        }

        const message = session.messages ? session.messages[adminId] : interaction.message;
        const result = await acceptSession(interaction.guild, citizenId, adminId, message);
        if (!result.success) {
          return interaction.reply({ content: `⚠️ ${result.reason}`, ephemeral: true });
        }

        try {
          const citizenMember = await interaction.guild.members.fetch(citizenId);
          const adminMember = await interaction.guild.members.fetch(adminId);
          const adminChannel = adminMember.voice.channel;
          if (adminChannel) {
            await citizenMember.voice.setChannel(adminChannel.id, 'قبول الجلسة - سحب المواطن');
            session.startTime = Date.now();
            session.status = 'accepted';
          }
        } catch (err) {
          console.error('⚠️ فشل سحب المواطن بعد القبول:', err);
        }

        return interaction.reply({ content: '✅ تم القبول وتم سحب المواطن.', ephemeral: true });
      }

      if (interaction.customId && interaction.customId.startsWith('reject_session_')) {
        const parts = interaction.customId.split('_');
        const citizenId = parts[2];
        const adminId = parts[3];

        if (interaction.user.id !== adminId) {
          return interaction.reply({
            content: '❌ هذا الزر مخصص لإداري آخر، لا يمكنك رفض هذه الجلسة.',
            ephemeral: true
          });
        }

        const session = activeSessions.get(citizenId);
        if (!session) {
          return interaction.reply({ content: '⚠️ هذه الجلسة غير موجودة.', ephemeral: true });
        }
        if (session.status !== 'pending') {
          return interaction.reply({ content: '⚠️ هذه الجلسة لم تعد معلقة.', ephemeral: true });
        }
        if (!session.pendingAdmins.includes(adminId)) {
          return interaction.reply({ content: '⚠️ هذا الطلب لم يعد متاحاً.', ephemeral: true });
        }

        const message = session.messages ? session.messages[adminId] : interaction.message;
        const result = await rejectSession(interaction.guild, citizenId, adminId, message);
        if (!result.success) {
          return interaction.reply({ content: `⚠️ ${result.reason}`, ephemeral: true });
        }

        return interaction.reply({ content: '❌ تم رفض الجلسة.', ephemeral: true });
      }

      if (interaction.customId && interaction.customId.startsWith('end_session_')) {
        const parts = interaction.customId.split('_');
        const citizenId = parts[2];
        const adminId = parts[3];

        if (interaction.user.id !== adminId) {
          return interaction.reply({ content: '❌ فقط الإداري المسؤول يمكنه الإنهاء.', ephemeral: true });
        }

        const session = activeSessions.get(citizenId);
        if (!session || session.status !== 'accepted') {
          return interaction.reply({ content: '⚠️ هذه الجلسة غير نشطة.', ephemeral: true });
        }

        const message = session.messages ? session.messages[adminId] : interaction.message;
        await endSession(interaction.guild, citizenId, adminId, session.startTime, message);
        return interaction.reply({ content: '✅ تم إنهاء الجلسة.', ephemeral: true });
      }

      // ===== أزرار التقييم =====
      if (interaction.customId && interaction.customId.startsWith('rate_')) {
        const parts = interaction.customId.split('_');
        const rating = parseInt(parts[1]);
        const adminId = parts[2];
        const logMsgId = parts[3];
        const stars = ratingStarsBar(rating);

        if (isLogEvaluated(logMsgId)) {
          return interaction.reply({ content: '⚠️ تم التقييم مسبقاً.', ephemeral: true });
        }

        markLogEvaluated(logMsgId);
        await interaction.update({ content: `✅ شكراً! (${stars})`, embeds: [], components: [] });

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
        } catch (e) { console.error('❌ خطأ في إرسال التقييم:', e); }

        try {
          if (logMsgId && logMsgId !== 'none') {
            const guild = client.guilds.cache.get(GUILD_ID);
            const channel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
            if (channel) {
              const msg = await channel.messages.fetch(logMsgId);
              if (msg) {
                const embed = EmbedBuilder.from(msg.embeds[0]);
                embed.addFields({ name: '⭐ التقييم', value: stars, inline: true });
                await msg.edit({ embeds: [embed] });
              }
            }
          }
        } catch (e) { console.error('❌ خطأ في تحديث التقييم:', e); }
        return;
      }

      // ===== أزرار الإجازات والاستقالات (نفس الكود السابق) =====
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

      if (interaction.commandName === 'top_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 لا توجد إحصائيات.', ephemeral: true });
        const sorted = [...doneCounts.entries()].sort((a,b) => b[1] - a[1]).slice(0,10);
        const desc = sorted.map(([id, count], i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i+1}**`;
          return `${medal} - <@${id}> : \`${count}\` Done`;
        }).join('\n');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 توب 10 إداريين').setColor(0xffd700).setDescription(desc)] });
      }

      if (interaction.commandName === 'all_dones') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 لا توجد إحصائيات.', ephemeral: true });
        const sorted = [...doneCounts.entries()].sort((a,b) => b[1] - a[1]);
        const desc = sorted.map(([id, count], i) => `**#${i+1}** - <@${id}> : \`${count}\` Done`).join('\n');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📊 جميع الإحصائيات').setColor(0x3498db).setDescription(desc.slice(0,4000))] });
      }

      if (interaction.commandName === 'add_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        doneCounts.set(admin.id, current + amount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم إضافة ${amount} إلى <@${admin.id}>. المجموع: ${current + amount}`, ephemeral: true });
      }

      if (interaction.commandName === 'remove_done') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');
        const current = doneCounts.get(admin.id) || 0;
        const newCount = Math.max(0, current - amount);
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();
        return interaction.reply({ content: `✅ تم خصم ${amount} من <@${admin.id}>. المجموع: ${newCount}`, ephemeral: true });
      }

      if (interaction.commandName === 'reset_all') {
        if (!hasStaffRole(interaction.member)) return interaction.reply({ content: '❌ غير مصرح.', ephemeral: true });
        doneCounts.clear();
        saveDoneCounts();
        return interaction.reply({ content: '🧹 تم تصفير جميع الإحصائيات.', ephemeral: true });
      }
    }
  } catch (error) {
    console.error('❌ خطأ في التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ.', ephemeral: true }).catch(() => null);
    }
  }
});

// ============================================================
// حفظ البيانات عند الإغلاق
// ============================================================
process.on('SIGINT', () => {
  console.log('🔄 حفظ البيانات...');
  saveDoneCounts();
  saveActiveLeaves();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔄 حفظ البيانات...');
  saveDoneCounts();
  saveActiveLeaves();
  process.exit(0);
});

client.login(BOT_TOKEN);
