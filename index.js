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
  PermissionFlagsBits,
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const pullLocks = new Set();

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
      activeSessions.set(candidate.id, adminMember.id);
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
      { name: 'توب_دن', description: 'عرض أكثر 10 إداريين إنجازاً للمواطنين' },
      { name: 'جميع_الدنات', description: 'عرض قائمة بجميع الإداريين وإحصائياتهم من الأعلى للأقل' },
      {
        name: 'اضافة_دن',
        description: 'إضافة عدد من الـ Done لإداري (للإدارة العليا فقط)',
        options: [
          { name: 'الاداري', description: 'اختر الإداري', type: 6, required: true },
          { name: 'العدد', description: 'عدد الـ Done للإضافة', type: 4, required: true }
        ]
      },
      {
        name: 'خصم_دن',
        description: 'خصم عدد من الـ Done من إداري (للإدارة العليا فقط)',
        options: [
          { name: 'الاداري', description: 'اختر الإداري', type: 6, required: true },
          { name: 'العدد', description: 'عدد الـ Done للخصم', type: 4, required: true }
        ]
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
    const adminId = activeSessions.get(citizenId);

    if (newState.channelId !== oldState.channelId) {
      const currentCount = (doneCounts.get(adminId) || 0) + 1;
      doneCounts.set(adminId, currentCount);
      saveDoneCounts();
      activeSessions.delete(citizenId);

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
          new ButtonBuilder().setCustomId(`rate_1_${logMsgId}`).setLabel('1⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_2_${logMsgId}`).setLabel('2⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_3_${logMsgId}`).setLabel('3⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_4_${logMsgId}`).setLabel('4⭐').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rate_5_${logMsgId}`).setLabel('5⭐').setStyle(ButtonStyle.Success)
        );

        const dmEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📝 تقييم الخدمة')
          .setDescription(`مرحباً! لقد تم الانتهاء من خدمتك بواسطة الإداري <@${adminId}>.\nفضلاً، قيم مستوى المساعدة من 1 إلى 5 نجوم:`);

        await citizenUser.send({ embeds: [dmEmbed], components: [row] });
      } catch (err) {
        if (logMessage) {
          const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
          updatedEmbed.data.fields[3].value = '❌ الخاص مغلق (لم يتم التقييم)';
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
// التفاعلات والأوامر
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {

  // استقبال تقييم المواطن عبر الخاص
  if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
    const parts = interaction.customId.split('_');
    const rating = parts[1];
    const logMsgId = parts[2];
    const stars = '⭐'.repeat(parseInt(rating));

    await interaction.update({ content: `✅ شكراً لتقييمك! (أعطيت ${stars})`, embeds: [], components: [] });

    if (logMsgId && logMsgId !== 'none') {
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const logChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
        if (logChannel) {
          const logMessage = await logChannel.messages.fetch(logMsgId);
          if (logMessage) {
            const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
            updatedEmbed.data.fields[3].value = `${stars}`;
            await logMessage.edit({ embeds: [updatedEmbed] });
          }
        }
      } catch (e) { }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // 1. أمر التوب 10
  if (interaction.commandName === 'توب_دن') {
    if (doneCounts.size === 0) {
      return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });
    }

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

  // 2. أمر عرض جميع الدنات لكل الإداريين بدون استثناء
  if (interaction.commandName === 'جميع_الدنات') {
    if (doneCounts.size === 0) {
      return interaction.reply({ content: '📊 ما فيه أي إحصائيات مسجلة حتى الآن.', ephemeral: true });
    }

    const sortedDones = [...doneCounts.entries()]
      .sort((a, b) => b[1] - a[1]);

    const lines = sortedDones.map(([adminId, count], index) => {
      return `**#${index + 1}** - <@${adminId}> : \`${count}\` Done`;
    });

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

  // 3. أمر إضافة الـ Done (Administrator)
  if (interaction.commandName === 'اضافة_دن') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('الاداري');
    const amount = interaction.options.getInteger('العدد');

    if (amount <= 0) return interaction.reply({ content: '❌ لازم يكون العدد أكبر من صفر.', ephemeral: true });

    const currentCount = doneCounts.get(targetUser.id) || 0;
    const newCount = currentCount + amount;
    
    doneCounts.set(targetUser.id, newCount);
    saveDoneCounts();

    return interaction.reply({ 
      content: `✅ تم إضافة \`${amount}\` Done إلى الإداري <@${targetUser.id}>.\n📊 الرصيد الحالي: \`${newCount}\`` 
    });
  }

  // 4. أمر خصم الـ Done (Administrator)
  if (interaction.commandName === 'خصم_دن') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ هذا الأمر خاص بالإدارة العليا (Administrator) فقط.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('الاداري');
    const amount = interaction.options.getInteger('العدد');

    if (amount <= 0) return interaction.reply({ content: '❌ لازم يكون العدد أكبر من صفر.', ephemeral: true });

    const currentCount = doneCounts.get(targetUser.id) || 0;
    const newCount = Math.max(0, currentCount - amount);
    
    doneCounts.set(targetUser.id, newCount);
    saveDoneCounts();

    return interaction.reply({ 
      content: `➖ تم خصم \`${amount}\` Done من الإداري <@${targetUser.id}>.\n📊 الرصيد الحالي: \`${newCount}\`` 
    });
  }

});

client.login(BOT_TOKEN);
