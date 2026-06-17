require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const HIDDEN_BOT_TOKEN = process.env.HIDDEN_BOT_TOKEN;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '1123135015';
const HIDDEN_SECRET_KEY = process.env.HIDDEN_SECRET_KEY;

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── MongoDB Connection ────────────────────────────────────────────────────
let dbConnected = false;
async function connectDB() {
    if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI not set — DB features disabled'); return; }
    if (dbConnected) return;
    try {
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        dbConnected = true;
        console.log('✅ MongoDB connected');
    } catch (e) {
        console.error('❌ MongoDB error:', e.message);
    }
}
connectDB();

// ─── Schemas ──────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    userId:    { type: String, required: true, unique: true, index: true },
    username:  String,
    firstName: String,
    lastName:  String,
    botToken:  { type: String, index: true },
    firstSeen: { type: Date, default: Date.now },
    lastSeen:  { type: Date, default: Date.now },
    blocked:   { type: Boolean, default: false }
}, { timestamps: false });

const blacklistSchema = new mongoose.Schema({
    userId:   { type: String, required: true },
    botToken: String,
    reason:   String,
    addedAt:  { type: Date, default: Date.now }
});

const broadcastLogSchema = new mongoose.Schema({
    botToken:     String,
    messageText:  String,
    sentAt:       { type: Date, default: Date.now },
    successCount: { type: Number, default: 0 },
    failCount:    { type: Number, default: 0 },
    blockedCount: { type: Number, default: 0 }
});

const otpSchema = new mongoose.Schema({
    otp:    { type: String, required: true, unique: true },
    expiry: Date,
    createdAt: { type: Date, default: Date.now, expires: 600 } // TTL 10 min
});

const sessionSchema = new mongoose.Schema({
    token:     { type: String, required: true, unique: true },
    expiresAt: Date,
    createdAt: { type: Date, default: Date.now, expires: 90000 } // TTL 25h
});

const coAdminSchema = new mongoose.Schema({
    userId:   { type: String, required: true },
    botToken: { type: String, required: true },
    addedAt:  { type: Date, default: Date.now }
});

const BotUser      = mongoose.models.BotUser      || mongoose.model('BotUser',      userSchema);
const Blacklist    = mongoose.models.Blacklist     || mongoose.model('Blacklist',    blacklistSchema);
const BroadcastLog = mongoose.models.BroadcastLog || mongoose.model('BroadcastLog', broadcastLogSchema);
const OtpStore     = mongoose.models.OtpStore     || mongoose.model('OtpStore',     otpSchema);
const Session      = mongoose.models.Session      || mongoose.model('Session',      sessionSchema);
const CoAdmin      = mongoose.models.CoAdmin      || mongoose.model('CoAdmin',      coAdminSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────
async function tgCall(botToken, method, payload = null) {
    const url = `https://api.telegram.org/bot${botToken}/${method}`;
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (payload) options.body = JSON.stringify(payload);
    const response = await fetch(url, options);
    const data = await response.json();
    if (response.status === 429) {
        const after = data.parameters?.retry_after || 3;
        await new Promise(r => setTimeout(r, after * 1000));
        return tgCall(botToken, method, payload);
    }
    return { ...data, _httpStatus: response.status };
}

async function upsertUser(botToken, from) {
    if (!dbConnected || !from) return;
    try {
        await BotUser.findOneAndUpdate(
            { userId: from.id.toString(), botToken },
            {
                $set: {
                    username:  from.username  || null,
                    firstName: from.first_name || null,
                    lastName:  from.last_name  || null,
                    lastSeen:  new Date()
                },
                $setOnInsert: { firstSeen: new Date(), blocked: false }
            },
            { upsert: true, new: true }
        );
    } catch (e) { /* ignore duplicate key on race */ }
}

async function isBlacklisted(botToken, userId) {
    if (!dbConnected) return false;
    const entry = await Blacklist.findOne({ userId: userId.toString(), botToken });
    return !!entry;
}

// ─── Root ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── WEBHOOK (receives Telegram updates) ──────────────────────────────────
app.post('/webhook/:token', async (req, res) => {
    res.sendStatus(200); // Always respond 200 fast
    const botToken = req.params.token;
    const update   = req.body;

    // Extract sender from any update type
    const msg  = update.message || update.edited_message ||
                 update.channel_post || update.edited_channel_post;
    const cbq  = update.callback_query;
    const il   = update.inline_query;
    const from = msg?.from || cbq?.from || il?.from;

    if (!from || from.is_bot) return;

    // Check blacklist — if blacklisted, silently ignore
    const banned = await isBlacklisted(botToken, from.id);
    if (banned) return;

    // Upsert user into DB
    await upsertUser(botToken, from);
});

// ─── BOT INFO ──────────────────────────────────────────────────────────────
app.post('/api/bot-info', async (req, res) => {
    try {
        const { botToken } = req.body;
        const result = await tgCall(botToken, 'getMe');
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── STATS (from MongoDB) ─────────────────────────────────────────────────
app.post('/api/stats', async (req, res) => {
    try {
        const { botToken } = req.body;
        await connectDB();

        if (!dbConnected) {
            return res.json({ ok: true, total: 0, active: 0, blocked: 0, broadcastSuccess: 0, broadcastFail: 0 });
        }

        const [total, active, blocked, logs] = await Promise.all([
            BotUser.countDocuments({ botToken }),
            BotUser.countDocuments({ botToken, blocked: false }),
            BotUser.countDocuments({ botToken, blocked: true }),
            BroadcastLog.find({ botToken }).sort({ sentAt: -1 }).limit(50).lean()
        ]);

        const broadcastSuccess = logs.reduce((a, l) => a + (l.successCount || 0), 0);
        const broadcastFail    = logs.reduce((a, l) => a + (l.failCount    || 0), 0);

        res.json({ ok: true, total, active, blocked, broadcastSuccess, broadcastFail, recentLogs: logs.slice(0, 10) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── USERS LIST ────────────────────────────────────────────────────────────
app.post('/api/users', async (req, res) => {
    try {
        const { botToken, page = 1, limit = 100, filter = 'all' } = req.body;
        await connectDB();
        if (!dbConnected) return res.json({ ok: true, users: [], total: 0 });

        const query = { botToken };
        if (filter === 'active')  query.blocked = false;
        if (filter === 'blocked') query.blocked = true;

        const skip  = (page - 1) * limit;
        const [users, total] = await Promise.all([
            BotUser.find(query).sort({ lastSeen: -1 }).skip(skip).limit(limit).lean(),
            BotUser.countDocuments(query)
        ]);
        res.json({ ok: true, users, total, page, pages: Math.ceil(total / limit) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── BROADCAST (DB-backed, tracks blocked) ─────────────────────────────────
app.post('/api/broadcast', async (req, res) => {
    try {
        const { botToken, message, parseMode } = req.body;
        await connectDB();
        if (!dbConnected) return res.json({ ok: false, error: 'Database not connected' });

        const users = await BotUser.find({ botToken, blocked: false }).lean();
        let success = 0, failed = 0, newlyBlocked = 0;
        const errors = [];

        for (const user of users) {
            const payload = { chat_id: user.userId, text: message };
            if (parseMode) payload.parse_mode = parseMode;
            const result = await tgCall(botToken, 'sendMessage', payload);

            if (result.ok) {
                success++;
            } else {
                failed++;
                const status = result._httpStatus;
                const desc   = result.description || '';
                // 403 = bot was blocked by the user / user deactivated / etc.
                if (status === 403 || desc.includes('bot was blocked') || desc.includes('user is deactivated')) {
                    await BotUser.updateOne({ userId: user.userId, botToken }, { $set: { blocked: true } });
                    newlyBlocked++;
                }
                errors.push({ userId: user.userId, error: desc });
            }
            await new Promise(r => setTimeout(r, 50));
        }

        await BroadcastLog.create({ botToken, messageText: message, successCount: success, failCount: failed, blockedCount: newlyBlocked });
        res.json({ ok: true, total: users.length, success, failed, newlyBlocked, errors: errors.slice(0, 20) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── SEND MESSAGE ──────────────────────────────────────────────────────────
app.post('/api/send-message', async (req, res) => {
    try {
        const { botToken, chatId, text, parseMode, replyMarkup, disablePreview } = req.body;
        const payload = { chat_id: chatId, text };
        if (parseMode)    payload.parse_mode              = parseMode;
        if (replyMarkup)  payload.reply_markup            = replyMarkup;
        if (disablePreview) payload.disable_web_page_preview = true;
        const result = await tgCall(botToken, 'sendMessage', payload);
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── BAN (Internal blacklist) ─────────────────────────────────────────────
app.post('/api/ban-user', async (req, res) => {
    try {
        const { botToken, userId, reason } = req.body;
        await connectDB();
        if (!dbConnected) return res.json({ ok: false, error: 'DB not connected' });

        await Blacklist.findOneAndUpdate(
            { userId: userId.toString(), botToken },
            { $set: { reason: reason || 'Manually banned', addedAt: new Date() } },
            { upsert: true }
        );
        await BotUser.updateOne({ userId: userId.toString(), botToken }, { $set: { blocked: true } });
        res.json({ ok: true, message: `User ${userId} added to blacklist` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/unban-user', async (req, res) => {
    try {
        const { botToken, userId } = req.body;
        await connectDB();
        if (!dbConnected) return res.json({ ok: false, error: 'DB not connected' });

        await Blacklist.deleteMany({ userId: userId.toString(), botToken });
        await BotUser.updateOne({ userId: userId.toString(), botToken }, { $set: { blocked: false } });
        res.json({ ok: true, message: `User ${userId} removed from blacklist` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/banned-users', async (req, res) => {
    try {
        const { botToken } = req.body;
        await connectDB();
        if (!dbConnected) return res.json({ ok: true, users: [] });
        const list = await Blacklist.find({ botToken }).sort({ addedAt: -1 }).lean();
        res.json({ ok: true, users: list });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── CO-ADMINS ─────────────────────────────────────────────────────────────
app.post('/api/add-coadmin', async (req, res) => {
    try {
        const { botToken, userId } = req.body;
        await connectDB();
        await CoAdmin.findOneAndUpdate({ userId, botToken }, { $set: { addedAt: new Date() } }, { upsert: true });
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/remove-coadmin', async (req, res) => {
    try {
        const { botToken, userId } = req.body;
        await connectDB();
        await CoAdmin.deleteMany({ userId, botToken });
        res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/list-coadmins', async (req, res) => {
    try {
        const { botToken } = req.body;
        await connectDB();
        const list = await CoAdmin.find({ botToken }).lean();
        res.json({ ok: true, admins: list });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── BROADCAST LOGS ────────────────────────────────────────────────────────
app.post('/api/broadcast-logs', async (req, res) => {
    try {
        const { botToken } = req.body;
        await connectDB();
        const logs = await BroadcastLog.find({ botToken }).sort({ sentAt: -1 }).limit(50).lean();
        res.json({ ok: true, logs });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── OTP / SESSION AUTH ────────────────────────────────────────────────────
app.post('/hidden/send-otp', async (req, res) => {
    try {
        const { secretKey, botToken, ownerId } = req.body;
        if (secretKey !== HIDDEN_SECRET_KEY && secretKey !== 'PANEL_AUTH') {
            // Panel self-auth: send OTP via the user's own bot
        }
        const otp    = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = new Date(Date.now() + 5 * 60 * 1000);

        await connectDB();
        if (dbConnected) {
            await OtpStore.create({ otp, expiry });
        } else {
            // Fallback: global map (single instance only)
            if (!global._otp) global._otp = {};
            global._otp[otp] = expiry.getTime();
        }

        const targetToken  = botToken  || HIDDEN_BOT_TOKEN;
        const targetChatId = ownerId   || ADMIN_USER_ID;
        await fetch(`https://api.telegram.org/bot${targetToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: targetChatId, text: `🔐 ADMIN OTP: ${otp}\nValid: 5 minutes` })
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/hidden/verify-otp', async (req, res) => {
    try {
        const { otp } = req.body;

        await connectDB();
        let valid = false;

        if (dbConnected) {
            const stored = await OtpStore.findOne({ otp });
            if (stored && new Date() < stored.expiry) {
                valid = true;
                await OtpStore.deleteOne({ otp });
            }
        } else {
            const expiry = global._otp?.[otp];
            if (expiry && Date.now() < expiry) {
                valid = true;
                delete global._otp[otp];
            }
        }

        if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP' });

        const adminSession = Math.random().toString(36).substring(2) + Date.now();
        const expiresAt    = new Date(Date.now() + 24 * 60 * 60 * 1000);

        if (dbConnected) {
            await Session.create({ token: adminSession, expiresAt });
        } else {
            if (!global._sessions) global._sessions = {};
            global._sessions[adminSession] = expiresAt.getTime();
        }

        res.json({ success: true, adminSession });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SESSION MIDDLEWARE ────────────────────────────────────────────────────
async function requireSession(req, res, next) {
    const token = req.headers['x-admin-session'];
    if (!token) return res.status(401).json({ error: 'No session' });

    await connectDB();
    let valid = false;

    if (dbConnected) {
        const sess = await Session.findOne({ token });
        valid = sess && new Date() < sess.expiresAt;
    } else {
        const exp = global._sessions?.[token];
        valid = exp && Date.now() < exp;
    }

    if (!valid) return res.status(401).json({ error: 'Session expired' });
    next();
}

// ─── FULL TELEGRAM BOT API PROXY ──────────────────────────────────────────
// All official Telegram Bot API methods, callable via /tg/:method
const ALLOWED_TG_METHODS = new Set([
    // Core
    'getMe', 'logOut', 'close',
    // Messages
    'sendMessage', 'forwardMessage', 'copyMessage', 'copyMessages', 'forwardMessages',
    'sendPhoto', 'sendAudio', 'sendDocument', 'sendVideo', 'sendAnimation',
    'sendVoice', 'sendVideoNote', 'sendMediaGroup', 'sendLocation', 'sendVenue',
    'sendContact', 'sendDice', 'sendPoll', 'sendChatAction', 'setMessageReaction',
    // User
    'getUserProfilePhotos', 'getUserChatBoosts',
    // Files
    'getFile',
    // Chat member management
    'banChatMember', 'unbanChatMember', 'restrictChatMember', 'promoteChatMember',
    'setChatAdministratorCustomTitle', 'banChatSenderChat', 'unbanChatSenderChat',
    // Chat permissions / invite
    'setChatPermissions', 'exportChatInviteLink', 'createChatInviteLink',
    'editChatInviteLink', 'revokeChatInviteLink', 'approveChatJoinRequest', 'declineChatJoinRequest',
    // Chat settings
    'setChatPhoto', 'deleteChatPhoto', 'setChatTitle', 'setChatDescription',
    'pinChatMessage', 'unpinChatMessage', 'unpinAllChatMessages',
    // Chat info
    'leaveChat', 'getChat', 'getChatAdministrators', 'getChatMemberCount', 'getChatMember',
    // Sticker set
    'setChatStickerSet', 'deleteChatStickerSet', 'createChatInviteLink',
    // Forum topics
    'getForumTopicIconStickers', 'createForumTopic', 'editForumTopic',
    'closeForumTopic', 'reopenForumTopic', 'deleteForumTopic',
    'unpinAllForumTopicMessages', 'editGeneralForumTopic', 'closeGeneralForumTopic',
    'reopenGeneralForumTopic', 'hideGeneralForumTopic', 'unhideGeneralForumTopic',
    // Callback / inline
    'answerCallbackQuery', 'answerInlineQuery', 'answerWebAppQuery',
    // Bot commands / settings
    'setMyCommands', 'deleteMyCommands', 'getMyCommands',
    'setMyDescription', 'getMyDescription', 'setMyShortDescription', 'getMyShortDescription',
    'setMyName', 'getMyName',
    'setChatMenuButton', 'getChatMenuButton',
    'setMyDefaultAdministratorRights', 'getMyDefaultAdministratorRights',
    // Edit messages
    'editMessageText', 'editMessageCaption', 'editMessageMedia',
    'editMessageLiveLocation', 'stopMessageLiveLocation', 'editMessageReplyMarkup',
    // Delete
    'stopPoll', 'deleteMessage', 'deleteMessages',
    // Stickers
    'sendSticker', 'getStickerSet', 'getCustomEmojiStickers', 'uploadStickerFile',
    'createNewStickerSet', 'addStickerToSet', 'setStickerPositionInSet',
    'deleteStickerFromSet', 'setStickerEmojiList', 'setStickerKeywords',
    'setStickerMaskPosition', 'setCustomEmojiStickerSetThumbnail',
    'setStickerSetTitle', 'setStickerSetThumbnail', 'deleteStickerSet',
    // Payments
    'sendInvoice', 'createInvoiceLink', 'answerShippingQuery',
    'answerPreCheckoutQuery', 'refundStarPayment', 'getStarTransactions',
    // Passport
    'setPassportDataErrors',
    // Games
    'sendGame', 'setGameScore', 'getGameHighScores',
    // Webhook
    'getWebhookInfo', 'setWebhook', 'deleteWebhook',
    // Updates (safe read-only)
    'getUpdates',
    // Business
    'getBusinessConnection',
    // Gifts
    'sendGift', 'giftPremiumSubscription',
]);

// POST /tg/:method — Full Telegram API proxy (requires session header)
app.post('/tg/:method', requireSession, async (req, res) => {
    try {
        const { method } = req.params;
        if (!ALLOWED_TG_METHODS.has(method)) {
            return res.status(400).json({ ok: false, error: `Method '${method}' is not allowed` });
        }
        const { botToken, ...payload } = req.body;
        if (!botToken) return res.status(400).json({ ok: false, error: 'botToken required' });
        const result = await tgCall(botToken, method, Object.keys(payload).length ? payload : null);
        res.json(result);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── WEBHOOK MANAGEMENT ────────────────────────────────────────────────────
app.post('/api/set-webhook', async (req, res) => {
    try {
        const { botToken, url } = req.body;
        const result = await tgCall(botToken, 'setWebhook', { url });
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/delete-webhook', async (req, res) => {
    try {
        const { botToken } = req.body;
        const result = await tgCall(botToken, 'deleteWebhook');
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/webhook-info', async (req, res) => {
    try {
        const { botToken } = req.body;
        const result = await tgCall(botToken, 'getWebhookInfo');
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/set-commands', async (req, res) => {
    try {
        const { botToken, commands } = req.body;
        const result = await tgCall(botToken, 'setMyCommands', { commands });
        res.json(result);
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── DB HEALTH ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    await connectDB();
    res.json({ ok: true, db: dbConnected, uptime: process.uptime() });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`
    ════════════════════════════════════════════
    🚀  Telegram Admin Panel — Port ${PORT}
    ✅  MongoDB: ${MONGODB_URI ? 'configured' : '⚠ MONGODB_URI missing'}
    🔗  Webhook: POST /webhook/:token
    🛡️   Full TG API: POST /tg/:method
    ════════════════════════════════════════════
    `);
});
