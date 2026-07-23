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

// يدعم أكثر من روم انتظار — اكتبهم بنفس المتغير مفصولين بفاصلة:
const WAITING_CHANNEL_IDS = WAITING_CHANNEL_ID
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ===== إعدادات عامة =====
const CITIZEN_ALLOWED_CATEGORY_ID = '1459304931013033994'; // الكاتاقوري المسموح بالسحب منه حصراً
const RATING_CHANNEL_ID = '1529482677516898555'; // روم تقييمات الإداريين المنفصل
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178'; // الروم اللي فيه لوحة طلبات الإجازة
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714'; // روم المسؤولين اللي توصله طلبات الإجازة/الاستقالة للمراجعة
const LEAVE_ROLE_ID = '1459304469127758027'; // الرتبة اللي تنعطى تلقائيًا عند قبول إجازة
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428'; // الرتبة الوحيدة اللي تضل عند قبول استقالة
const STAFF_ROLE_IDS = ['1459304407899443396', '1459304410923532481']; // الرتب المسموح لها تستخدم أوامر البوت
const DONE_TEXT_CHANNEL_ID = '1476746882993623150'; // الروم اللي ترسل فيه سجلات الـ Done

// 🎯 قائمة رومات الإداريين المسموح للبوت يسحب المواطنين لها حصراً — أي روم غير هذي القائمة ما ينسحب له أحد
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

// ===== نظام حفظ إحصائيات الـ Done =====
const DONE_FILE = path.join(__dirname, 'done_stats.json');

function loadDoneCounts() {
  try {
    const raw = fs.readFileSync(DONE_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map();
  }
}

function saveDoneCounts() {
  const obj = Object.fromEntries(doneCounts);
  fs.writeFileSync(DONE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const doneCounts = loadDoneCounts();

function ratingStarsBar(rating) {
  const filled = '⭐'.repeat(rating);
  const empty = '☆'.repeat(5 - rating);
  return filled + empty;
}

function ratingColor(rating) {
  if (rating >= 4) return 0x2ecc71; // 4-5: أخضر
  if (rating >= 2) return 0xf1a10c; // 2-3: برتقالي
  return 0xed4245; // 1: أحمر
}

function ratingLabel(rating) {
  const labels = { 1: 'ضعيف جدًا', 2: 'ضعيف', 3: 'متوسط', 4: 'جيد', 5: 'ممتاز' };
  return labels[rating] || '';
}

const MAX_LEAVE_DAYS = 14; // الحد الأقصى لأيام الإجازة
const LEAVE_PANEL_COLOR = 0xC2410C; // برتقالي غامق
const LEAVE_BANNER_PATH = path.join(__dirname, 'leave_banner.png');
const LEAVE_BANNER_FILENAME = 'leave_banner.png';
const SERVER_LOGO_PATH = path.join(__dirname, 'server_logo.png');
const SERVER_LOGO_FILENAME = 'server_logo.png';

// ===== نظام حفظ الإجازات النشطة =====
const LEAVES_FILE = path.join(__dirname, 'active_leaves.json');

function loadActiveLeaves() {
  try {
    const raw = fs.readFileSync(LEAVES_FILE, 'utf8');
    return new Map(Object.entries(JSON.parse(raw)));
  } catch (err) {
    return new Map();
  }
}

function saveActiveLeaves() {
  const obj = Object.fromEntries(activeLeaves);
  fs.writeFileSync(LEAVES_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

const activeLeaves = loadActiveLeaves();

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
const activeSessions = new Map();

// ============================================================
// حماية روم الإجازات (حذف أي رسالة عضو فيه)
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (message.author.bot) return;

    const isAdmin = message.member && hasStaffRole(message.member);
    if (!isAdmin) {
      try {
        await message.delete();
      } catch (err) {
        console.error('❌ فشل حذف رسالة العضو في روم الإجازات:', err);
      }
    }
  }
});

// ============================================================
// دوال مساعدة لنظام السحب
// ============================================================
function isMutedOrDeafened(voiceState) {
  if (!voiceState) return false;
  return (
    voiceState.selfMute ||
    voiceState.selfDeaf ||
    voiceState.serverMute ||
    voiceState.serverDeaf
  );
}

// للإداري فقط: الميوت ما يمنع السحب، بس الديفن (Deafen) يمنعه
function isDeafened(voiceState) {
  if (!voiceState) return false;
  return voiceState.selfDeaf || voiceState.serverDeaf;
}

function getNextEligibleWaitingMember(guild) {
  for (const waitingId of WAITING_CHANNEL_IDS) {
    const waitingChannel = guild.channels.cache.get(waitingId);
    if (!waitingChannel || !waitingChannel.members) continue;

    // 🔒 التحقق من أن روم الانتظار يقع داخل الكاتاقوري المحدد حصراً
    if (waitingChannel.parentId !== CITIZEN_ALLOWED_CATEGORY_ID) continue;

    for (const [, member] of waitingChannel.members) {
      if (CITIZEN_ROLE_ID && !member.roles.cache.has(CITIZEN_ROLE_ID)) continue;

      const vs = member.voice;

      // 🔒 شرط إضافي: التأكد من أن القناة الصوتية للمواطن في الكاتاقوري المحدد
      if (vs.channel && vs.channel.parentId !== CITIZEN_ALLOWED_CATEGORY_ID) continue;

      if (!isMutedOrDeafened(vs)) {
        return member;
      }
    }
  }
  return null;
}

function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2) return false;

  // 🎯 السحب مسموح فقط لهذي الرومات المحددة — أي روم ثاني يترفض فورًا حتى لو داخل نفس الكاتاقوري
  if (!ADMIN_ROOM_IDS.includes(channel.id)) return false;

  const members = [...channel.members.values()];
  if (members.length !== 1) return false;

  const adminMember = members[0];
  if (!adminMember.roles.cache.has(ADMIN_ROLE_ID)) return false;
  if (isDeafened(adminMember.voice)) return false;

  return true;
}

async function tryPullForAllFreeAdmins(guild) {
  for (const roomId of ADMIN_ROOM_IDS) {
    const channel = guild.channels.cache.get(roomId);
    if (!channel) continue;
    if (!isFreeAdminRoom(channel)) continue;
    if (pullLocks.has(channel.id)) continue;

    const candidate = getNextEligibleWaitingMember(guild);
    if (!candidate) continue;

    pullLocks.add(channel.id);
    try {
      const adminMember = channel.members.first();
      await candidate.voice.setChannel(channel.id, 'سحب تلقائي لمواطن إلى إداري فاضي');

      activeSessions.set(candidate.id, {
        adminId: adminMember.id,
        startTime: Date.now()
      });

      console.log(`✅ تم سحب ${candidate.user.tag} إلى ${channel.name} (الإداري: ${adminMember.user.tag})`);
    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ============================================================
// تسجيل الأوامر عند تشغيل البوت
// ============================================================
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);

  try {
    const commands = [
      {
        name: 'send_leave_panel',
        description: 'إرسال لوحة طلبات الإجازات والاستقالات في روم الإجازات المخصص (للإدارة فقط)'
      },
      {
        name: 'active_leaves',
        description: 'عرض قائمة بالإداريين المجازين حالياً والوقت المتبقي لانتهاء إجازتهم (للإدارة فقط)'
      },
      { name: 'top_done', description: 'عرض أكثر 10 إداريين إنجازاً للمواطنين' },
      { name: 'all_dones', description: 'عرض قائمة بجميع الإداريين وإحصائياتهم من الأعلى للأقل' },
      {
        name: 'add_done',
        description: 'إضافة عدد من الـ Done لإداري (للإدارة العليا فقط)',
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للإضافة', type: 4, required: true }
        ]
      },
      {
        name: 'remove_done',
        description: 'خصم عدد من الـ Done من إداري (للإدارة العليا فقط)',
        options: [
          { name: 'admin', description: 'اختر الإداري', type: 6, required: true },
          { name: 'amount', description: 'عدد الـ Done للخصم', type: 4, required: true }
        ]
      },
      {
        name: 'reset_all',
        description: 'تصفير جميع إحصائيات الـ Done لجميع الإداريين (للإدارة العليا فقط)'
      }
    ];

    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تحديث وتسجيل أوامر السلاش بنجاح.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

// ============================================================
// حركة الصوت (السحب التلقائي فقط)
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const citizenId = newState.id;

  if (activeSessions.has(citizenId) && newState.channelId !== oldState.channelId) {
    const { adminId, startTime } = activeSessions.get(citizenId);
    activeSessions.delete(citizenId);

    const durationSec = Math.floor((Date.now() - startTime) / 1000);

    if (durationSec >= 5) {
      const minutes = Math.floor(durationSec / 60);
      const seconds = durationSec % 60;
      const durationText = minutes > 0 ? `${minutes} دقيقة و ${seconds} ثانية` : `${seconds} ثانية`;

      // ===== احتساب الـ Done وإرسال سجل بروم الـ Done =====
      const currentCount = (doneCounts.get(adminId) || 0) + 1;
      doneCounts.set(adminId, currentCount);
      saveDoneCounts();

      let logMessage = null;
      try {
        const doneChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
        if (doneChannel) {
          const doneEmbed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ تم إنهاء خدمة مواطن (Done)')
            .addFields(
              { name: '👤 المواطن', value: `<@${citizenId}>`, inline: true },
              { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
              { name: '📊 مجموع الـ Done', value: `\`${currentCount}\``, inline: true },
              { name: '⏱️ مدة الخدمة', value: `\`${durationText}\``, inline: true },
              { name: '⭐ التقييم', value: '⏳ بانتظار تقييم المواطن عبر الخاص...', inline: false }
            )
            .setTimestamp();

          logMessage = await doneChannel.send({ embeds: [doneEmbed] });
        }
      } catch (err) {
        console.error('❌ خطأ أثناء إرسال سجل الـ Done:', err);
      }

      try {
        const citizenUser = client.users.cache.get(citizenId) || await client.users.fetch(citizenId);
        const logMsgId = logMessage ? logMessage.id : 'none';

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rate_1_${adminId}_${logMsgId}`).setLabel('1⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_2_${adminId}_${logMsgId}`).setLabel('2⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_3_${adminId}_${logMsgId}`).setLabel('3⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_4_${adminId}_${logMsgId}`).setLabel('4⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_5_${adminId}_${logMsgId}`).setLabel('5⭐').setStyle(ButtonStyle.Success)
        );

        const dmEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📝 تقييم الخدمة')
          .setDescription(`مرحباً! لقد تم الانتهاء من خدمتك بواسطة الإداري <@${adminId}> في مدة ${durationText}.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`);

        await citizenUser.send({ embeds: [dmEmbed], components: [row] });
      } catch (err) {
        if (logMessage) {
          try {
            const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
            const fields = updatedEmbed.data.fields;
            fields[4].value = '❌ الخاص مغلق (لم يتم التقييم)';
            updatedEmbed.setFields(fields);
            await logMessage.edit({ embeds: [updatedEmbed] });
          } catch (editErr) {
            console.error('⚠️ خطأ أثناء تحديث سجل الـ Done (خاص مغلق):', editErr);
          }
        }
      }
    }
  }

  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    console.error('خطأ أثناء محاولة السحب:', err);
  }
});

// ============================================================
// الأوامر، الأزرار، والـ Modals
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  try {

    // --------------------------------------------------------
    // التعامل مع الأزرار
    // --------------------------------------------------------
    if (interaction.isButton()) {

      // 0. أزرار تقييم الإداري
      if (interaction.customId.startsWith('rate_')) {
        const parts = interaction.customId.split('_');
        const rating = parseInt(parts[1]);
        const adminId = parts[2];
        const logMsgId = parts[3];
        const stars = ratingStarsBar(rating);

        await interaction.update({ content: `✅ شكراً لتقييمك! (أعطيت ${stars})`, embeds: [], components: [] });

        try {
          const guild = client.guilds.cache.get(GUILD_ID);
          const ratingChannel = guild.channels.cache.get(RATING_CHANNEL_ID);
          if (ratingChannel) {
            const logoFile = new AttachmentBuilder(SERVER_LOGO_PATH, { name: SERVER_LOGO_FILENAME });

            const ratingEmbed = new EmbedBuilder()
              .setColor(ratingColor(rating))
              .setAuthor({
                name: `${interaction.user.username} قيّم الخدمة`,
                iconURL: interaction.user.displayAvatarURL({ dynamic: true })
              })
              .setTitle('🌟 تقييم إداري جديد')
              .setThumbnail(`attachment://${SERVER_LOGO_FILENAME}`)
              .addFields(
                { name: '👤 المواطن', value: `<@${interaction.user.id}>`, inline: true },
                { name: '🛡️ الإداري', value: adminId ? `<@${adminId}>` : 'غير معروف', inline: true },
                { name: '\u200b', value: '\u200b', inline: false },
                { name: '⭐ التقييم', value: `${stars}\n\`${rating}/5\` — **${ratingLabel(rating)}**`, inline: false }
              )
              .setFooter({ text: 'نظام تقييم الخدمة' })
              .setTimestamp();

            await ratingChannel.send({ embeds: [ratingEmbed], files: [logoFile] });
          }
        } catch (e) {
          console.error('❌ خطأ أثناء معالجة وإرسال التقييم:', e);
        }

        // تحديث سجل الـ Done بنفس التقييم
        try {
          if (logMsgId && logMsgId !== 'none') {
            const guild = client.guilds.cache.get(GUILD_ID);
            const doneChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
            if (doneChannel) {
              const logMessage = await doneChannel.messages.fetch(logMsgId);
              if (logMessage) {
                const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
                const fields = updatedEmbed.data.fields;
                fields[4].value = stars;
                updatedEmbed.setFields(fields);
                await logMessage.edit({ embeds: [updatedEmbed] });
              }
            }
          }
        } catch (e) {
          console.error('❌ خطأ أثناء تحديث سجل الـ Done بالتقييم:', e);
        }
        return;
      }

      // 1. زر فتح نموذج طلب الإجازة
      if (interaction.customId === 'open_leave_modal') {
        const modal = new ModalBuilder()
          .setCustomId('leave_modal')
          .setTitle('📄 طلب إجازة');

        const durationInput = new TextInputBuilder()
          .setCustomId('leave_duration')
          .setLabel(`عدد أيام الإجازة (أقصى حد ${MAX_LEAVE_DAYS} أيام)`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('مثال: 3')
          .setRequired(true)
          .setMaxLength(2);

        const reasonInput = new TextInputBuilder()
          .setCustomId('leave_reason')
          .setLabel('سبب الإجازة')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب طلب الإجازة بالتفصيل')
          .setRequired(true)
          .setMaxLength(500);

        modal.addComponents(
          new ActionRowBuilder().addComponents(durationInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );

        await interaction.showModal(modal);
        return;
      }

      // 2. زر فتح نموذج طلب الاستقالة
      if (interaction.customId === 'open_resign_modal') {
        const modal = new ModalBuilder()
          .setCustomId('resign_modal')
          .setTitle('📝 طلب استقالة');

        const reasonInput = new TextInputBuilder()
          .setCustomId('resign_reason')
          .setLabel('سبب الاستقالة')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب تقديم الاستقالة بالتفصيل')
          .setRequired(true)
          .setMaxLength(500);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        await interaction.showModal(modal);
        return;
      }

      // 2.5 زر فتح نموذج طلب كسر الإجازة
      if (interaction.customId === 'open_break_modal') {
        const modal = new ModalBuilder()
          .setCustomId('break_modal')
          .setTitle('🔓 طلب كسر إجازة');

        const reasonInput = new TextInputBuilder()
          .setCustomId('break_reason')
          .setLabel('سبب كسر الإجازة')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('اكتب سبب كسر الإجازة بالتفصيل')
          .setRequired(true)
          .setMaxLength(500);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        await interaction.showModal(modal);
        return;
      }

      // 3. أزرار قبول/رفض طلب إجازة أو استقالة
      if (interaction.customId.startsWith('req_accept_') || interaction.customId.startsWith('req_reject_')) {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({
            content: '❌ هذا الإجراء خاص بأصحاب صلاحية الإدارة فقط.',
            ephemeral: true,
          });
        }

        const parts = interaction.customId.split('_');
        const decision = parts[1];
        const reqType = parts[2];
        const requesterId = parts[3];

        const isAccept = decision === 'accept';
        const decisionLabel = isAccept ? '✅ تم القبول' : '❌ تم الرفض';
        const decisionColor = isAccept ? 0x2ecc71 : 0xe74c3c;

        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fields = originalEmbed.data.fields || [];
        const statusIndex = fields.findIndex((f) => f.name.includes('الحالة') || f.name.includes('Status'));
        const statusValue = `\`\`\`\n${decisionLabel} بواسطة ${interaction.user.username}\n\`\`\``;

        if (statusIndex >= 0) {
          fields[statusIndex].value = statusValue;
        } else {
          fields.push({ name: 'الحالة', value: statusValue });
        }

        originalEmbed.setFields(fields);
        originalEmbed.setColor(decisionColor);

        const oldComponents = interaction.message.components[0].components;
        const disabledRow = new ActionRowBuilder().addComponents(
          oldComponents.map((btn) => ButtonBuilder.from(btn).setDisabled(true))
        );

        await interaction.update({ embeds: [originalEmbed], components: [disabledRow] });

        let roleActionNote = '';
        if (isAccept) {
          try {
            const targetMember = await interaction.guild.members.fetch(requesterId);

            if (reqType === 'leave') {
              await targetMember.roles.add(LEAVE_ROLE_ID, 'قبول طلب إجازة');
              roleActionNote = `\n🏷️ تم تحديث حالتك إلى: **Out of service ✈️**`;

              const durationField = originalEmbed.data.fields.find(f => f.name.includes('المدة'));
              if (durationField) {
                const match = durationField.value.match(/\d+/);
                if (match) {
                  const durationDays = parseInt(match[0]);
                  const endDate = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
                  activeLeaves.set(requesterId, { endDate });
                  saveActiveLeaves();
                }
              }

            } else if (reqType === 'resign') {
              await targetMember.roles.set([RESIGNATION_KEEP_ROLE_ID], 'قبول طلب استقالة');
              roleActionNote = `\n🏷️ تم تحديث حالتك إلى: **𝗪𝗵𝗶𝘁𝗲𝗹𝗶𝘀𝘁𝗲𝗱**`;
            } else if (reqType === 'break') {
              if (targetMember.roles.cache.has(LEAVE_ROLE_ID)) {
                await targetMember.roles.remove(LEAVE_ROLE_ID, 'قبول طلب كسر إجازة');
                roleActionNote = `\n🏷️ تم سحب رتبة <@&${LEAVE_ROLE_ID}> منك (العودة من الإجازة).`;
              }
              if (activeLeaves.has(requesterId)) {
                activeLeaves.delete(requesterId);
                saveActiveLeaves();
              }
            }
          } catch (roleErr) {
            console.error('⚠️ خطأ أثناء تعديل الرتب:', roleErr);
          }
        }

        try {
          const requesterUser = await client.users.fetch(requesterId);
          const typeLabels = { leave: 'إجازة', resign: 'استقالة', break: 'كسر إجازة' };
          const typeLabel = typeLabels[reqType] || 'إجازة';

          const dmEmbed = new EmbedBuilder()
            .setTitle(isAccept ? '🎉 تم قبول طلبك' : '❌ تم رفض طلبك')
            .setColor(isAccept ? 0x2ecc71 : 0xe74c3c)
            .setDescription(
              isAccept
                ? `تهانينا! تم قبول طلب **الـ ${typeLabel}** الخاص بك.${roleActionNote}`
                : `للأسف، تم رفض طلب **الـ ${typeLabel}** الخاص بك.`
            )
            .addFields(
              { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'نوع الطلب', value: `طلب ${typeLabel}`, inline: true }
            )
            .setTimestamp();

          await requesterUser.send({ embeds: [dmEmbed] });
        } catch (e) {
          console.error('⚠️ تعذر إرسال الرسالة لخاص العضو.');
        }
        return;
      }
    }

    // --------------------------------------------------------
    // التعامل مع إرسال النماذج (Modals)
    // --------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const requestsChannel = await interaction.guild.channels.fetch(LEAVE_PANEL_CHANNEL_ID);

      const buildApplicationEmbed = (typeTitle, fieldsData) => {
        return new EmbedBuilder()
          .setColor(0x2f3136)
          .setTitle(`📨 A new application has been submitted. (${typeTitle})`)
          .setDescription(`**From:** <@${interaction.user.id}>\n\`( ${interaction.user.username} )\``)
          .addFields(fieldsData)
          .setFooter({
            text: `Submitted by ${interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ dynamic: true })
          })
          .setTimestamp();
      };

      if (interaction.customId === 'leave_modal') {
        const durationRaw = interaction.fields.getTextInputValue('leave_duration').trim();
        const reason = interaction.fields.getTextInputValue('leave_reason').trim();
        const duration = Number(durationRaw);

        if (!Number.isInteger(duration) || duration < 1) {
          return await interaction.reply({
            content: '❌ لازم تكتب عدد أيام صحيح (رقم صحيح 1 أو أكثر).',
            ephemeral: true,
          });
        }

        if (duration > MAX_LEAVE_DAYS) {
          return await interaction.reply({
            content: `❌ ما يصير تطلب إجازة أكثر من ${MAX_LEAVE_DAYS} أيام. الرجاء إعادة المحاولة بمدة أقل.`,
            ephemeral: true,
          });
        }

        const embed = buildApplicationEmbed('طلب إجازة', [
          { name: 'المدة', value: `\`\`\`\n${duration} ${duration === 1 ? 'يوم' : 'أيام'}\n\`\`\`` },
          { name: 'سبب الإجازة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_leave_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_leave_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب الإجازة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          ephemeral: true,
        });
      }

      if (interaction.customId === 'resign_modal') {
        const reason = interaction.fields.getTextInputValue('resign_reason').trim();

        const embed = buildApplicationEmbed('طلب استقالة', [
          { name: 'سبب الاستقالة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_resign_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_resign_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب الاستقالة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          ephemeral: true,
        });
      }

      if (interaction.customId === 'break_modal') {
        const reason = interaction.fields.getTextInputValue('break_reason').trim();

        const embed = buildApplicationEmbed('طلب كسر إجازة', [
          { name: 'سبب كسر الإجازة', value: `\`\`\`\n${reason}\n\`\`\`` },
          { name: 'الحالة', value: `\`\`\`\n⏳ بانتظار مراجعة الإدارة\n\`\`\`` }
        ]);

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_break_${interaction.user.id}`)
            .setLabel('قبول')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_break_${interaction.user.id}`)
            .setLabel('رفض')
            .setStyle(ButtonStyle.Danger)
        );

        await requestsChannel.send({ embeds: [embed], components: [decisionRow] });

        return await interaction.reply({
          content: '✅ تم إرسال طلب كسر الإجازة بنجاح إلى روم المسؤولين، بانتظار مراجعة الإدارة.',
          ephemeral: true,
        });
      }
    }

    // --------------------------------------------------------
    // التعامل مع الأوامر (Slash Commands)
    // --------------------------------------------------------
    if (interaction.isChatInputCommand()) {

      if (interaction.commandName === 'send_leave_panel') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }

        const panelEmbed = new EmbedBuilder()
          .setTitle('📋 نظام طلبات الإجازات والاستقالات')
          .setDescription(
            [
              'اختر نوع الطلب اللي تبيه من الأزرار تحت:',
              '',
              `📄 **طلب إجازة** — لطلب إجازة (بحد أقصى ${MAX_LEAVE_DAYS} أيام) مع ذكر السبب.`,
              '🔓 **طلب كسر إجازة** — إذا رجعت من إجازتك بدري وتبي توضح السبب.',
              '📝 **طلب استقالة** — لتقديم طلب استقالة مع ذكر السبب.',
            ].join('\n')
          )
          .setColor(LEAVE_PANEL_COLOR)
          .setImage(`attachment://${LEAVE_BANNER_FILENAME}`)
          .setFooter({ text: 'يرجى تعبئة البيانات بدقة قبل الإرسال' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_leave_modal')
            .setLabel('طلب إجازة')
            .setEmoji('📄')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('open_break_modal')
            .setLabel('طلب كسر إجازة')
            .setEmoji('🔓')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId('open_resign_modal')
            .setLabel('طلب استقالة')
            .setEmoji('📝')
            .setStyle(ButtonStyle.Danger)
        );

        const bannerFile = new AttachmentBuilder(LEAVE_BANNER_PATH, { name: LEAVE_BANNER_FILENAME });

        try {
          const panelChannel = await interaction.guild.channels.fetch(LEAVE_EMBED_CHANNEL_ID);
          await panelChannel.send({ embeds: [panelEmbed], components: [row], files: [bannerFile] });

          return interaction.reply({
            content: `✅ تم إرسال لوحة الإجازات والاستقالات في روم الإمبد <#${LEAVE_EMBED_CHANNEL_ID}>.`,
            ephemeral: true,
          });
        } catch (err) {
          console.error('❌ خطأ أثناء إرسال لوحة الاجازات:', err);
          return interaction.reply({
            content: '⚠️ ما قدرت أرسل اللوحة. تأكد إن البوت عنده صلاحية إرسال رسائل وصور بذاك الروم.',
            ephemeral: true,
          });
        }
      }

      if (interaction.commandName === 'active_leaves') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }

        if (activeLeaves.size === 0) {
          return interaction.reply({ content: '🌴 لا يوجد أي إداري في إجازة حالياً.', ephemeral: true });
        }

        let expiredCount = 0;
        const now = Date.now();
        let description = '';
        let index = 1;

        for (const [userId, leaveData] of activeLeaves.entries()) {
          if (now > leaveData.endDate) {
            activeLeaves.delete(userId);
            expiredCount++;
            continue;
          }

          const remainingMs = leaveData.endDate - now;
          const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
          const remainingHours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

          let timeText = '';
          if (remainingDays > 0) timeText += `${remainingDays} يوم و `;
          timeText += `${remainingHours} ساعة`;

          description += `**${index}.** <@${userId}> — ينتهي بعد: \`${timeText}\`\n`;
          index++;
        }

        if (expiredCount > 0) saveActiveLeaves();

        if (description === '') {
          description = '✅ كانت هناك إجازات في السجل ولكن جميعها انتهت الآن.';
        }

        const embed = new EmbedBuilder()
          .setTitle(' قائمة الإجازات النشطة')
          .setColor(0x3ba55d)
          .setDescription(description)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      // أمر التوب 10
      if (interaction.commandName === 'top_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });

        const sortedDones = [...doneCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        const description = sortedDones.map(([adminId, count], index) => {
          const medals = ['🥇', '🥈', '🥉'];
          const rank = index < 3 ? medals[index] : `**#${index + 1}**`;
          return `${rank} - <@${adminId}> : \`${count}\` Done`;
        }).join('\n\n');

        const embed = new EmbedBuilder()
          .setTitle('🏆 توب 10 إداريين (أكثر من ساعد المواطنين)')
          .setColor(0xffd700)
          .setDescription(description);

        return interaction.reply({ embeds: [embed] });
      }

      // أمر عرض الكل
      if (interaction.commandName === 'all_dones') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة فقط.', ephemeral: true });
        }
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });

        const sortedDones = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]);

        const description = sortedDones.map(([adminId, count], index) => {
          return `**#${index + 1}** - <@${adminId}> : \`${count}\` Done`;
        }).join('\n');

        const embed = new EmbedBuilder()
          .setTitle('📊 إحصائيات جميع الإداريين (Done)')
          .setColor(0x3498db)
          .setDescription(description.length > 4096 ? description.slice(0, 4090) + '...' : description);

        return interaction.reply({ embeds: [embed] });
      }

      // إضافة إنجازات
      if (interaction.commandName === 'add_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        const currentCount = doneCounts.get(admin.id) || 0;
        const newCount = currentCount + amount;
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();

        return interaction.reply({ content: `✅ تم إضافة \`${amount}\` إلى إحصائيات <@${admin.id}>. المجموع الحالي: \`${newCount}\``, ephemeral: true });
      }

      // خصم إنجازات
      if (interaction.commandName === 'remove_done') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        const admin = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        const currentCount = doneCounts.get(admin.id) || 0;
        const newCount = Math.max(0, currentCount - amount);
        doneCounts.set(admin.id, newCount);
        saveDoneCounts();

        return interaction.reply({ content: `✅ تم خصم \`${amount}\` من إحصائيات <@${admin.id}>. المجموع الحالي: \`${newCount}\``, ephemeral: true });
      }

      // تصفير الإحصائيات
      if (interaction.commandName === 'reset_all') {
        if (!hasStaffRole(interaction.member)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بأصحاب صلاحية الإدارة العليا فقط.', ephemeral: true });
        }

        doneCounts.clear();
        saveDoneCounts();

        return interaction.reply({ content: '🧹 تم تصفير جميع إحصائيات الـ Done بنجاح!', ephemeral: true });
      }
    }
  } catch (error) {
    console.error('❌ خطأ أثناء معالجة التفاعل:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ حدث خطأ أثناء معالجة الطلب.', ephemeral: true }).catch(() => null);
    }
  }
});

client.login(BOT_TOKEN);
