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
  console.error('❌ تأكد من تعبئة المتغيرات في ملف .env (تم الآن الاعتماد بشكل أساسي على DONE_TEXT_CHANNEL_ID للوج)');
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

// خريطة لتتبع أي إداري يتعامل مع أي مواطن حالياً (citizenId -> adminId)
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

      // تسجيل الجلسة لبدء المتابعة
      activeSessions.set(candidate.id, adminMember.id);
      console.log(`✅ تم سحب ${candidate.user.tag} إلى ${channel.name} (الإداري: ${adminMember.user.tag})`);
    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
});

// ============================================================
// فحص الحركة الصوتية (خروج المواطن + احتساب Done + إرسال التقييم)
// ============================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  const citizenId = newState.id;

  // إذا كان هذا العضو مواطن مسجل حالياً بجلسة مع إداري
  if (activeSessions.has(citizenId)) {
    const adminId = activeSessions.get(citizenId);

    // إذا قام بتغيير الروم (سواء طلع من نفسه، أو نقله الإداري لأي روم آخر بما فيها روم Done)
    if (newState.channelId !== oldState.channelId) {
      
      // 1. إعطاء الـ Done للإداري
      const currentCount = (doneCounts.get(adminId) || 0) + 1;
      doneCounts.set(adminId, currentCount);
      saveDoneCounts();

      // مسح الجلسة عشان ما تتكرر
      activeSessions.delete(citizenId);

      // 2. إرسال اللوج في روم السيرفر
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

      // 3. إرسال أزرار التقييم في خاص المواطن
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
        console.error(`❌ مقدرت أرسل رسالة التقييم للمواطن ${citizenId} (الخاص مغلق).`);
        // تحديث رسالة اللوج إذا كان الخاص مغلق
        if (logMessage) {
          const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
          updatedEmbed.data.fields[3].value = '❌ الخاص مغلق (لم يتم التقييم)';
          await logMessage.edit({ embeds: [updatedEmbed] });
        }
      }
    }
  }

  // محاولة السحب التلقائي بعد أي تغيير
  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    console.error('خطأ أثناء محاولة السحب:', err);
  }
});

// ============================================================
// التفاعلات (أمر السحب + أزرار التقييم)
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  
  // 1. استقبال تقييم المواطن من الخاص
  if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
    const parts = interaction.customId.split('_');
    const rating = parts[1];
    const logMsgId = parts[2];

    const stars = '⭐'.repeat(parseInt(rating));

    // شكر المواطن على التقييم في الخاص وإخفاء الأزرار
    await interaction.update({
      content: `✅ شكراً لتقييمك! (أعطيت ${stars} نجوم)`,
      embeds: [],
      components: []
    });

    // تحديث رسالة اللوج الأساسية في السيرفر
    if (logMsgId && logMsgId !== 'none') {
      try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const logChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
        if (logChannel) {
          const logMessage = await logChannel.messages.fetch(logMsgId);
          if (logMessage) {
            const updatedEmbed = EmbedBuilder.from(logMessage.embeds[0]);
            updatedEmbed.data.fields[3].value = `${stars}`; // استبدال الـ ⏳ بالنجوم الفعلية
            await logMessage.edit({ embeds: [updatedEmbed] });
          }
        }
      } catch (e) {
        console.error('❌ خطأ في تحديث رسالة التقييم في السيرفر:', e);
      }
    }
    return;
  }

  // 2. أمر /سحب اليدوي
  if (interaction.isChatInputCommand() && interaction.commandName === 'سحب') {
    const member = interaction.member;

    if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
      return interaction.reply({ content: '❌ هذا الأمر خاص بالإداريين بس.', ephemeral: true });
    }

    const voiceState = member.voice;
    if (!voiceState.channelId) {
      return interaction.reply({ content: '❌ لازم تكون داخل روم صوتي.', ephemeral: true });
    }

    if (isMutedOrDeafened(voiceState)) {
      return interaction.reply({ content: '❌ لا يمكنك سحب مواطن وأنت حاط ميوت أو ديفن!', ephemeral: true });
    }

    const channel = voiceState.channel;
    if ([...channel.members.values()].length > 1) {
      return interaction.reply({ content: '❌ لازم تكون لحالك بالروم.', ephemeral: true });
    }

    const candidate = getNextEligibleWaitingMember(interaction.guild);
    if (!candidate) {
      return interaction.reply({ content: 'ℹ️ ما فيه أحد مؤهل حاليًا بروم الانتظار.', ephemeral: true });
    }

    try {
      await candidate.voice.setChannel(channel.id, `سحب يدوي بواسطة ${member.user.tag}`);
      
      // تسجيل الجلسة في حالة السحب اليدوي لكي تعمل ميزة التقييم والخروج
      activeSessions.set(candidate.id, member.id);

      return interaction.reply({ content: `✅ تم سحب <@${candidate.id}> إلى روومك.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '⚠️ فشل السحب تأكد من صلاحية Move Members.', ephemeral: true });
    }
  }
});

client.login(BOT_TOKEN);
