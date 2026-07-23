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
  DONE_TEXT_CHANNEL_ID,
} = process.env;

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID || !DONE_TEXT_CHANNEL_ID) {
  console.error('❌ تأكد من تعبئة جميع المتغيرات في ملف .env');
  process.exit(1);
}

// ===== إعدادات عامة =====
const RATING_CHANNEL_ID = '1529577728117047453'; // آيدي روم التقييمات المنفصل
const LEAVE_EMBED_CHANNEL_ID = '1529581700663869500'; // روم إمبد الإجازات
const LEAVE_PANEL_CHANNEL_ID = '1529582419248681111'; // روم المسؤولين
const LEAVE_ROLE_ID = '1529635475655102625'; // الرتبة عند قبول الإجازة
const RESIGNATION_KEEP_ROLE_ID = '1529504750003945632'; // الرتبة المتبقية عند قبول الاستقالة
const MAX_LEAVE_DAYS = 10; // الحد الأقصى لأيام الإجازة
const LEAVE_PANEL_COLOR = 0xC2410C; // برتقالي غامق
const LEAVE_BANNER_PATH = path.join(__dirname, 'leave_banner.png');
const LEAVE_BANNER_FILENAME = 'leave_banner.png';

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
const activeSessions = new Map();

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

// ============================================================
// حماية روم الإجازات (حذف أي رسالة عضو فيه)
// ============================================================
client.on(Events.MessageCreate, async (message) => {
  if (message.guild && message.channelId === LEAVE_EMBED_CHANNEL_ID) {
    if (!message.author.bot) {
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

function getNextEligibleWaitingMember(guild) {
  const waitingChannel = guild.channels.cache.get(WAITING_CHANNEL_ID);
  if (!waitingChannel || !waitingChannel.members) return null;

  for (const [, member] of waitingChannel.members) {
    if (CITIZEN_ROLE_ID && !member.roles.cache.has(CITIZEN_ROLE_ID)) continue;

    const vs = member.voice;
    if (!isMutedOrDeafened(vs)) {
      return member;
    }
  }
  return null;
}

function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2) return false;
  if (ADMIN_CATEGORY_ID && channel.parentId !== ADMIN_CATEGORY_ID) return false;
  if (channel.id === WAITING_CHANNEL_ID) return false;
  if (DONE_VOICE_CHANNEL_ID && channel.id === DONE_VOICE_CHANNEL_ID) return false;

  const members = [...channel.members.values()];
  if (members.length !== 1) return false;

  const adminMember = members[0];
  if (!adminMember.roles.cache.has(ADMIN_ROLE_ID)) return false;
  if (isMutedOrDeafened(adminMember.voice)) return false;

  return true;
}

async function tryPullForAllFreeAdmins(guild) {
  const voiceChannels = guild.channels.cache.filter((c) => c.type === 2);

  for (const [, channel] of voiceChannels) {
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
      },
      {
        name: 'send_leave_panel',
        description: 'إرسال لوحة طلبات الإجازات والاستقالات في روم الإجازات المخصص (للإدارة فقط)'
      },
      {
        name: 'active_leaves',
        description: 'عرض قائمة بالإداريين المجازين حالياً والوقت المتبقي لانتهاء إجازتهم (للإدارة فقط)'
      }
    ];

    await c.application.commands.set(commands, GUILD_ID);
    console.log('✅ تم تحديث وتسجيل أوامر السلاش بنجاح.');
  } catch (error) {
    console.error('❌ خطأ في تسجيل الأوامر:', error);
  }
});

// ============================================================
// حركة الصوت واحتساب الـ Done والتقييم
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const citizenId = newState.id;

  if (activeSessions.has(citizenId)) {
    const sessionData = activeSessions.get(citizenId);
    const adminId = sessionData.adminId;
    const startTime = sessionData.startTime;

    if (newState.channelId !== oldState.channelId) {
      activeSessions.delete(citizenId);

      const durationMs = Date.now() - startTime;
      const durationSec = Math.floor(durationMs / 1000);

      if (durationSec < 10) {
        console.log(`🚫 تلاعب محتمل: تم تجاهل الـ Done للإداري ${adminId} مع المواطن ${citizenId} (المدة: ${durationSec} ثواني)`);
        return;
      }

      const minutes = Math.floor(durationSec / 60);
      const seconds = durationSec % 60;
      const durationText = minutes > 0 ? `${minutes} دقيقة و ${seconds} ثانية` : `${seconds} ثانية`;

      const currentCount = (doneCounts.get(adminId) || 0) + 1;
      doneCounts.set(adminId, currentCount);
      saveDoneCounts();

      let logMessage = null;
      try {
        const logChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
        if (logChannel) {
          const embed = new EmbedBuilder()
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

          logMessage = await logChannel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('❌ خطأ أثناء إرسال لوج الـ Done:', err);
      }

      try {
        const citizenUser = client.users.cache.get(citizenId) || await client.users.fetch(citizenId);
        const logMsgId = logMessage ? logMessage.id : 'none';

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rate_1_${logMsgId}_${adminId}`).setLabel('1⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_2_${logMsgId}_${adminId}`).setLabel('2⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_3_${logMsgId}_${adminId}`).setLabel('3⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_4_${logMsgId}_${adminId}`).setLabel('4⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_5_${logMsgId}_${adminId}`).setLabel('5⭐').setStyle(ButtonStyle.Success)
        );

        const dmEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📝 تقييم الخدمة')
          .setDescription(`مرحباً! لقد تم الانتهاء من خدمتك بواسطة الإداري <@${adminId}> في مدة ${durationText}.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`);

        await citizenUser.send({ embeds: [dmEmbed], components: [row] });
      } catch (err) {
        if (logMessage) {
          const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
          updatedEmbed.data.fields[4].value = '❌ الخاص مغلق (لم يتم التقييم)';
          await logMessage.edit({ embeds: [updatedEmbed] });
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

      // 1. أزرار تقييم الإداري
      if (interaction.customId.startsWith('rate_')) {
        const parts = interaction.customId.split('_');
        const rating = parts[1];
        const logMsgId = parts[2];
        const adminId = parts[3];
        const stars = '⭐'.repeat(parseInt(rating));

        await interaction.update({ content: `✅ شكراً لتقييمك! (أعطيت ${stars})`, embeds: [], components: [] });

        try {
          const guild = client.guilds.cache.get(GUILD_ID);

          if (logMsgId && logMsgId !== 'none') {
            const logChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
            if (logChannel) {
              const logMessage = await logChannel.messages.fetch(logMsgId);
              if (logMessage) {
                const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
                updatedEmbed.data.fields[4].value = `${stars}`;
                await logMessage.edit({ embeds: [updatedEmbed] });
              }
            }
          }

          const ratingChannel = guild.channels.cache.get(RATING_CHANNEL_ID);
          if (ratingChannel) {
            const ratingEmbed = new EmbedBuilder()
              .setColor(0xffd700)
              .setTitle('🌟 تقييم خدمة جديد')
              .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
              .addFields(
                { name: '👤 المواطن', value: `<@${interaction.user.id}>`, inline: true },
                { name: '🛡️ الإداري', value: adminId ? `<@${adminId}>` : 'غير معروف', inline: true },
                { name: '⭐ التقييم', value: stars, inline: false }
              )
              .setTimestamp();

            await ratingChannel.send({ embeds: [ratingEmbed] });
          }
        } catch (e) {
          console.error('❌ خطأ أثناء معالجة وإرسال التقييم:', e);
        }
        return;
      }

      // 2. زر فتح نموذج (Modal) طلب الإجازة
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

      // 3. زر فتح نموذج (Modal) طلب الاستقالة
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

      // 3.5 زر فتح نموذج (Modal) طلب كسر الإجازة
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

      // 4. أزرار قبول/رفض طلب إجازة أو استقالة (للمسؤولين فقط)
      if (interaction.customId.startsWith('req_accept_') || interaction.customId.startsWith('req_reject_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({
            content: '❌ هذا الإجراء خاص بالإدارة العليا (Administrator) فقط.',
            ephemeral: true,
          });
        }

        const parts = interaction.customId.split('_');
        const decision = parts[1];
        const reqType = parts[2];
        const requesterId = parts[3];

        const isAccept = decision === 'accept';
        const decisionLabel = isAccept ? '✅ تم القبول' : '❌ تم الرفض';
        const decisionColor = isAccept ? 0x3ba55d : 0xed4245;

        const originalEmbed = EmbedBuilder.from(interaction.message.embeds[0]);
        const fields = originalEmbed.data.fields || [];
        const statusIndex = fields.findIndex((f) => f.name.includes('الحالة'));
        const statusValue = `${decisionLabel} بواسطة <@${interaction.user.id}>`;

        if (statusIndex >= 0) {
          fields[statusIndex].value = statusValue;
        } else {
          fields.push({ name: '📌 الحالة', value: statusValue });
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
              roleActionNote = `\n🏷️ تم إعطاؤك رتبة <@&${LEAVE_ROLE_ID}> تلقائيًا.`;
              
              // استخراج عدد الأيام من الإمبد الأصلي وحفظها في قائمة الإجازات النشطة
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
              roleActionNote = `\n🏷️ تم سحب جميع رتبك ما عدا <@&${RESIGNATION_KEEP_ROLE_ID}>.`;
            } else if (reqType === 'break') {
              if (targetMember.roles.cache.has(LEAVE_ROLE_ID)) {
                await targetMember.roles.remove(LEAVE_ROLE_ID, 'قبول طلب كسر إجازة');
                roleActionNote = `\n🏷️ تم سحب رتبة <@&${LEAVE_ROLE_ID}> منك (العودة من الإجازة).`;
              }
              // إزالة الشخص من قائمة المجازين النشطين بمجرد الموافقة على الكسر
              if (activeLeaves.has(requesterId)) {
                activeLeaves.delete(requesterId);
                saveActiveLeaves();
              }
            }
          } catch (roleErr) {
            console.error('⚠️ خطأ أثناء تعديل الرتب:', roleErr);
          }
        }

        // ============================================================
        // إرسال Embed مخصص للخاص مطابق لتصميم الصورة
        // ============================================================
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
          console.error('⚠️ تعذر إرسال الرسالة لخاص العضو (قد تكون إعدادات الخصوصية مغلقة).');
        }
        return;
      }
    }

    // --------------------------------------------------------
    // التعامل مع إرسال النماذج (Modals)
    // --------------------------------------------------------
    if (interaction.isModalSubmit()) {
      const requestsChannel = await interaction.guild.channels.fetch(LEAVE_PANEL_CHANNEL_ID);

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

        const embed = new EmbedBuilder()
          .setTitle('📄 طلب إجازة جديد')
          .setColor(0x3ba55d)
          .addFields(
            { name: '👤 مقدم الطلب', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📅 المدة', value: `${duration} ${duration === 1 ? 'يوم' : 'أيام'}`, inline: true },
            { name: '📝 السبب', value: reason },
            { name: '📌 الحالة', value: '⏳ بانتظار مراجعة الإدارة' }
          )
          .setThumbnail(interaction.user.displayAvatarURL())
          .setTimestamp();

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_leave_${interaction.user.id}`)
            .setLabel('قبول')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_leave_${interaction.user.id}`)
            .setLabel('رفض')
            .setEmoji('❌')
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

        const embed = new EmbedBuilder()
          .setTitle('📝 طلب استقالة جديد')
          .setColor(0xed4245)
          .addFields(
            { name: '👤 مقدم الطلب', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📝 السبب', value: reason },
            { name: '📌 الحالة', value: '⏳ بانتظار مراجعة الإدارة' }
          )
          .setThumbnail(interaction.user.displayAvatarURL())
          .setTimestamp();

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_resign_${interaction.user.id}`)
            .setLabel('قبول')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_resign_${interaction.user.id}`)
            .setLabel('رفض')
            .setEmoji('❌')
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

        const embed = new EmbedBuilder()
          .setTitle('🔓 طلب كسر إجازة جديد')
          .setColor(0xf1a10c)
          .addFields(
            { name: '👤 مقدم الطلب', value: `<@${interaction.user.id}>`, inline: true },
            { name: '📝 سبب كسر الإجازة', value: reason },
            { name: '📌 الحالة', value: '⏳ بانتظار مراجعة الإدارة' }
          )
          .setThumbnail(interaction.user.displayAvatarURL())
          .setTimestamp();

        const decisionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`req_accept_break_${interaction.user.id}`)
            .setLabel('قبول')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`req_reject_break_${interaction.user.id}`)
            .setLabel('رفض')
            .setEmoji('❌')
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
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
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

      if (interaction.commandName === 'top_done') {
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
          .setDescription(description)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'all_dones') {
        if (doneCounts.size === 0) return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });

        const sortedDones = [...doneCounts.entries()].sort((a, b) => b[1] - a[1]);
        const lines = sortedDones.map(([adminId, count], index) => `**#${index + 1}** - <@${adminId}> : \`${count}\` Done`);

        let fullText = lines.join('\n');
        if (fullText.length > 3900) {
          fullText = fullText.substring(0, 3900) + '\n\n⚠️ تم اختصار جزء من القائمة لكبر حجم البيانات.';
        }

        const embed = new EmbedBuilder()
          .setTitle('📋 قائمة إحصائيات جميع الإداريين (من الأعلى للأقل)')
          .setColor(0x3498db)
          .setDescription(fullText)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === 'add_done') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) return interaction.reply({ content: '❌ لازم يكون العدد أكبر من صفر.', ephemeral: true });

        const currentCount = doneCounts.get(targetUser.id) || 0;
        const newCount = currentCount + amount;

        doneCounts.set(targetUser.id, newCount);
        saveDoneCounts();

        return interaction.reply({
          content: `✅ تم إضافة \`${amount}\` Done إلى الإداري <@${targetUser.id}>.\n📊 الرصيد الحالي: \`${newCount}\``
        });
      }

      if (interaction.commandName === 'remove_done') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('admin');
        const amount = interaction.options.getInteger('amount');

        if (amount <= 0) return interaction.reply({ content: '❌ لازم يكون العدد أكبر من صفر.', ephemeral: true });

        const currentCount = doneCounts.get(targetUser.id) || 0;
        const newCount = Math.max(0, currentCount - amount);

        doneCounts.set(targetUser.id, newCount);
        saveDoneCounts();

        return interaction.reply({
          content: `➖ تم خصم \`${amount}\` Done من الإداري <@${targetUser.id}>.\n📊 الرصيد الحالي: \`${newCount}\``
        });
      }

      if (interaction.commandName === 'reset_all') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
        }

        doneCounts.clear();
        saveDoneCounts();

        return interaction.reply({
          content: '⚠️ ✅ **تم تصفير جميع إحصائيات الـ Done لجميع الإداريين بنجاح.**'
        });
      }

      if (interaction.commandName === 'active_leaves') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
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
            // الإجازة انتهت وقتها
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

        // تحديث الملف إذا كان فيه إجازات انتهت وتم تنظيفها
        if (expiredCount > 0) saveActiveLeaves();

        if (description === '') {
          description = '✅ كانت هناك إجازات في السجل ولكن جميعها انتهت الآن.';
        }

        const embed = new EmbedBuilder()
          .setTitle('🌴 قائمة الإجازات النشطة')
          .setColor(0x3ba55d)
          .setDescription(description)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    }

  } catch (err) {
    console.error('⚠️ خطأ أثناء معالجة التفاعل:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '⚠️ صار خطأ غير متوقع، حاول مرة ثانية.',
        ephemeral: true,
      });
    }
  }
});

client.login(BOT_TOKEN);
