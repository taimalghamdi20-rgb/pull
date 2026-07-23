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
const RATING_CHANNEL_ID = '1529482677516898555'; // روم تقييمات الإداريين المنفصل
const LEAVE_EMBED_CHANNEL_ID = '1529495796247167178'; // الروم اللي فيه لوحة طلبات الإجازة
const LEAVE_PANEL_CHANNEL_ID = '1529440458030321714'; // روم المسؤولين اللي توصله طلبات الإجازة/الاستقالة للمراجعة
const LEAVE_ROLE_ID = '1459304469127758027'; // الرتبة اللي تنعطى تلقائيًا عند قبول إجازة
const RESIGNATION_KEEP_ROLE_ID = '1476796533168017428'; // الرتبة الوحيدة اللي تضل عند قبول استقالة
const STAFF_ROLE_ID = '1459304407899443396'; // الرتبة الوحيدة المسموح لها تستخدم أوامر البوت

function hasStaffRole(member) {
  return member.roles.cache.has(STAFF_ROLE_ID);
}

function ratingStarsBar(rating) {
  const filled = '⭐'.repeat(rating);
  const empty = '☆'.repeat(5 - rating);
  return filled + empty;
}

function ratingColor(rating) {
  const colors = { 1: 0xed4245, 2: 0xf1a10c, 3: 0xfee75c, 4: 0x57f287, 5: 0x2ecc71 };
  return colors[rating] || 0xffd700;
}

function ratingLabel(rating) {
  const labels = { 1: 'ضعيف جدًا', 2: 'ضعيف', 3: 'متوسط', 4: 'جيد', 5: 'ممتاز' };
  return labels[rating] || '';
}
const MAX_LEAVE_DAYS = 10; // الحد الأقصى لأيام الإجازة
const LEAVE_PANEL_COLOR = 0xC2410C; // برتقالي غامق
const LEAVE_BANNER_PATH = path.join(__dirname, 'leave_banner.png');
const LEAVE_BANNER_FILENAME = 'leave_banner.png';

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

    const isAdmin = message.member && message.member.permissions.has(PermissionFlagsBits.Administrator);
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

function getNextEligibleWaitingMember(guild) {
  for (const waitingId of WAITING_CHANNEL_IDS) {
    const waitingChannel = guild.channels.cache.get(waitingId);
    if (!waitingChannel || !waitingChannel.members) continue;

    for (const [, member] of waitingChannel.members) {
      if (CITIZEN_ROLE_ID && !member.roles.cache.has(CITIZEN_ROLE_ID)) continue;

      const vs = member.voice;
      if (!isMutedOrDeafened(vs)) {
        return member;
      }
    }
  }
  return null;
}

function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2) return false;
  if (ADMIN_CATEGORY_ID && channel.parentId !== ADMIN_CATEGORY_ID) return false;
  if (WAITING_CHANNEL_IDS.includes(channel.id)) return false;
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

      try {
        const citizenUser = client.users.cache.get(citizenId) || await client.users.fetch(citizenId);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rate_1_${adminId}`).setLabel('1⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_2_${adminId}`).setLabel('2⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_3_${adminId}`).setLabel('3⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_4_${adminId}`).setLabel('4⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_5_${adminId}`).setLabel('5⭐').setStyle(ButtonStyle.Success)
        );

        const dmEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📝 تقييم الخدمة')
          .setDescription(`مرحباً! لقد تم الانتهاء من خدمتك بواسطة الإداري <@${adminId}> في مدة ${durationText}.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`);

        await citizenUser.send({ embeds: [dmEmbed], components: [row] });
      } catch (err) {
        // التجاهل عند إغلاق الخاص
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
        const stars = ratingStarsBar(rating);

        await interaction.update({ content: `✅ شكراً لتقييمك! (أعطيت ${stars})`, embeds: [], components: [] });

        try {
          const guild = client.guilds.cache.get(GUILD_ID);
          const ratingChannel = guild.channels.cache.get(RATING_CHANNEL_ID);
          if (ratingChannel) {
            const ratingEmbed = new EmbedBuilder()
              .setColor(ratingColor(rating))
              .setAuthor({
                name: `${interaction.user.username} قيّم الخدمة`,
                iconURL: interaction.user.displayAvatarURL({ dynamic: true })
              })
              .setTitle('🌟 تقييم خدمة جديد')
              .addFields(
                { name: '👤 المواطن', value: `<@${interaction.user.id}>`, inline: true },
                { name: '🛡️ الإداري', value: adminId ? `<@${adminId}>` : 'غير معروف', inline: true },
                { name: '\u200b', value: '\u200b', inline: false },
                { name: '⭐ التقييم', value: `${stars}\n\`${rating}/5\` — **${ratingLabel(rating)}**`, inline: false }
              )
              .setFooter({ text: 'نظام تقييم الخدمة' })
              .setTimestamp();

            await ratingChannel.send({ embeds: [ratingEmbed] });
          }
        } catch (e) {
          console.error('❌ خطأ أثناء معالجة وإرسال التقييم:', e);
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

      // تصميم الـ Embed المطابق للصورة
      const buildApplicationEmbed = (typeTitle, fieldsData) => {
        return new EmbedBuilder()
          .setColor(0x2f3136) // لون داكن مطابق للديسكورد
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
