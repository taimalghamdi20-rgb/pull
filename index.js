require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
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

if (!BOT_TOKEN || !GUILD_ID || !WAITING_CHANNEL_ID || !ADMIN_ROLE_ID || !DONE_VOICE_CHANNEL_ID || !DONE_TEXT_CHANNEL_ID) {
  console.error('❌ لازم تعبي جميع المتغيرات المطلوبة في ملف .env بما فيها DONE_VOICE_CHANNEL_ID و DONE_TEXT_CHANNEL_ID');
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

// لمنع تكرار السحب لنفس الروم بنفس اللحظة
const pullLocks = new Set();

/**
 * يتحقق هل العضو حاطّ ميوت أو ديفن (سواء بنفسه أو من السيرفر)
 */
function isMutedOrDeafened(voiceState) {
  if (!voiceState) return false;
  return (
    voiceState.selfMute ||
    voiceState.selfDeaf ||
    voiceState.serverMute ||
    voiceState.serverDeaf
  );
}

/**
 * يرجع أول عضو مؤهل بروم الانتظار (مو ميوت/ديفن)
 */
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

/**
 * يتحقق هل قناة صوتية معينة هي "روم إداري فاضي":
 * فيها إداري واحد بس (لحاله)، ما فيها غيره، ومو حاط ميوت ولا ديفن
 */
function isFreeAdminRoom(channel) {
  if (!channel || channel.type !== 2 /* GuildVoice */) return false;
  if (ADMIN_CATEGORY_ID && channel.parentId !== ADMIN_CATEGORY_ID) return false;
  if (channel.id === WAITING_CHANNEL_ID) return false;
  if (channel.id === DONE_VOICE_CHANNEL_ID) return false;

  const members = [...channel.members.values()];
  if (members.length !== 1) return false;

  const adminMember = members[0];

  // شرط: لازم يكون إداري + غير مفعّل للميوت أو الديفن
  if (!adminMember.roles.cache.has(ADMIN_ROLE_ID)) return false;
  if (isMutedOrDeafened(adminMember.voice)) return false;

  return true;
}

/**
 * يسوي عملية السحب التلقائي
 */
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

      // ربط المواطن بالإداري لمعرفة من ساعده عند إرساله للـ Done
      activeSessions.set(candidate.id, adminMember.id);
      console.log(`✅ تم سحب ${candidate.user.tag} إلى روم ${channel.name} (الإداري: ${adminMember.user.tag})`);
    } catch (err) {
      console.error(`⚠️ فشل سحب ${candidate.user.tag}:`, err.message);
    } finally {
      pullLocks.delete(channel.id);
    }
  }
}

// ============================================================
// أحداث البوت
// ============================================================

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 البوت شغال باسم ${c.user.tag}`);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  // 1. فحص نقل المواطن إلى روم الـ Done الصوتي
  if (newState.channelId === DONE_VOICE_CHANNEL_ID && oldState.channelId !== DONE_VOICE_CHANNEL_ID) {
    let adminId = activeSessions.get(newState.id);

    // إذا لم تُسجل الجلسة تلقائياً، نفحص من كان معه في الروم السابق قبل النقل
    if (!adminId && oldState.channel) {
      const prevAdmin = oldState.channel.members.find(
        (m) => m.roles.cache.has(ADMIN_ROLE_ID) && m.id !== newState.id
      );
      if (prevAdmin) adminId = prevAdmin.id;
    }

    if (adminId) {
      // زيادة عدد الـ Done للإداري وحفظه
      const currentCount = (doneCounts.get(adminId) || 0) + 1;
      doneCounts.set(adminId, currentCount);
      saveDoneCounts();

      // إرسال اللوج في روم الـ Done الكتابي
      try {
        const logChannel = guild.channels.cache.get(DONE_TEXT_CHANNEL_ID);
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ تم إنهاء خدمة مواطن (Done)')
            .addFields(
              { name: '👤 المواطن', value: `<@${newState.id}>`, inline: true },
              { name: '🛡️ الإداري', value: `<@${adminId}>`, inline: true },
              { name: '📊 مجموع الـ Done للإداري', value: `\`${currentCount}\``, inline: true }
            )
            .setTimestamp();

          await logChannel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error('❌ خطأ أثناء إرسال لوج الـ Done:', err);
      }

      // إزالة المواطن من الجلسات النشطة
      activeSessions.delete(newState.id);
    }
  }

  // 2. محاولة السحب التلقائي بعد أي تغيير في الحالة الصوتية
  try {
    await tryPullForAllFreeAdmins(guild);
  } catch (err) {
    console.error('خطأ أثناء محاولة السحب:', err);
  }
});

// ============================================================
// أمر /سحب — يسحب الإداري نفسه مواطن يدويًا
// ============================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'سحب') return;

  const member = interaction.member;

  if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
    return interaction.reply({
      content: '❌ هذا الأمر خاص بالإداريين بس.',
      ephemeral: true,
    });
  }

  const voiceState = member.voice;
  if (!voiceState.channelId) {
    return interaction.reply({
      content: '❌ لازم تكون داخل روم صوتي عشان تستخدم الأمر.',
      ephemeral: true,
    });
  }

  // منع السحب إذا كان الإداري حاط ميوت أو ديفن
  if (isMutedOrDeafened(voiceState)) {
    return interaction.reply({
      content: '❌ لا يمكنك سحب مواطن وأنت حاط ميوت أو ديفن!',
      ephemeral: true,
    });
  }

  const channel = voiceState.channel;
  const membersInChannel = [...channel.members.values()];
  if (membersInChannel.length > 1) {
    return interaction.reply({
      content: '❌ لازم تكون لحالك بالروم عشان ينسحب لك مواطن.',
      ephemeral: true,
    });
  }

  const candidate = getNextEligibleWaitingMember(interaction.guild);
  if (!candidate) {
    return interaction.reply({
      content: 'ℹ️ ما فيه أحد مؤهل حاليًا بروم الانتظار (يمكن الكل حاطين ميوت/ديفن أو الروم فاضي).',
      ephemeral: true,
    });
  }

  try {
    await candidate.voice.setChannel(channel.id, `سحب يدوي بواسطة ${member.user.tag}`);
    
    // ربط المواطن بالإداري للسحب اليدوي
    activeSessions.set(candidate.id, member.id);

    return interaction.reply({
      content: `✅ تم سحب <@${candidate.id}> إلى روومك.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: '⚠️ صار خطأ أثناء محاولة السحب. تأكد إن البوت عنده صلاحية Move Members.',
      ephemeral: true,
    });
  }
});

client.login(BOT_TOKEN);
