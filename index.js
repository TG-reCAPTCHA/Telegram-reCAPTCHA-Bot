require('dotenv').config();
const jwt = require('jsonwebtoken');
const Telegraf = require('telegraf');
const CryptoJS = require('crypto-js');
const escapeHtml = require('escape-html');
const request = require('request-promise');
const telegrafAws = require('telegraf-aws');
const commandParts = require('telegraf-command-parts');

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        webhookReply: false,
    },
});

bot.use(commandParts());

bot.telegram.getMe().then((botInfo) => {
    bot.options.username = botInfo.username;
});

const updateHandler = telegrafAws(bot, {
    timeout: 3000,
});

bot.command('start', async (ctx) => {
    if (ctx.message.chat.type !== 'private') {
        return 0;
    }

    try {
        const pasteID = ctx.state.command.args;
        if (!pasteID) {
            ctx.telegram.webhookReply = true;
            throw new Error('This bot is only using to verify machine-generated code, you may check out https://github.com/TG-reCAPTCHA/Telegram-reCAPTCHA-Bot for more information.');
        }

        const response = await request({
            url: 'https://bytebin.lucko.me/' + pasteID,
            resolveWithFullResponse: true,
        });
        if (response && response.statusCode !== 200) {
            throw new Error(
                'Error when trying to retrieve payload from Pastebin, you may try to use the backup method provided in the verification page or just rest for a while and try again.\n' +
                    'Status code: ' +
                    (response && response.statusCode)
            );
        }

        const payload = JSON.parse(CryptoJS.AES.decrypt(response.body, ctx.message.from.id.toString()).toString(CryptoJS.enc.Utf8));

        if (!payload || !payload.jwt || !payload.gresponse) {
            throw new Error();
        }

        return await verifyUser(payload, ctx);
    } catch (err) {
        let msg = 'Invalid data from Pastebin, please try again later or use the backup method provided in the verification page.';
        if (err.__proto__.toString() === 'Error' && err.message) {
            if (err.message === 'Malformed UTF-8 data') {
                msg =
                    "You can't verify account for another person. \nIf you sure you are now trying to verify yourself account instead of others, please try to use the backup method shown in verify page or just rest for a while and try again.";
            } else if (err.message === '404 - "Invalid path"') {
                msg = 'Invalid data from Pastebin, please try again later or use the backup method provided in the verification page.';
            } else {
                msg = err.message;
            }
        }
        ctx.replyWithMarkdown(msg);
        return 1;
    }
});

bot.command('verify', async (ctx) => {
    if (ctx.message.chat.type !== 'private') {
        return 0;
    }

    try {
        if (!ctx.state.command.args) {
            ctx.telegram.webhookReply = true;
            throw new Error('This bot is only using to verify machine-generated code, you may check out https://github.com/TG-reCAPTCHA/Telegram-reCAPTCHA-Bot for more information.');
        }

        const payload = JSON.parse(new Buffer(ctx.state.command.args, 'base64').toString());
        if (!payload || !payload.jwt || !payload.gresponse) {
            ctx.telegram.webhookReply = true;
            throw new Error();
        }

        return await verifyUser(payload, ctx);
    } catch (err) {
        let msg = 'Invalid data, please try again later.';
        if (err.__proto__.toString() === 'Error' && err.message) {
            msg = err.message;
        }
        ctx.replyWithMarkdown(msg);
        return 1;
    }
});

bot.on('new_chat_members', async (ctx) => {
    ctx.message.new_chat_members
        .filter(({ is_bot }) => !is_bot)
        .forEach((user) => {
            ctx.telegram.restrictChatMember(ctx.message.chat.id, user.id);
        });

    // Pre-reply user joins message, record message id to JWT for subsequent deletion operation.
    ctx.message.new_chat_members
        .filter(({ is_bot }) => !is_bot)
        .forEach(async (user) => {
            const { message_id } = await ctx.reply('Processing...', {
                reply_to_message_id: ctx.message.message_id,
            });

            const jwtoken = jwt.sign(
                {
                    exp: Math.floor(Date.now() / 1000) + 60 * 10,
                    data: {
                        mid: message_id,
                        uid: user.id.toString(),
                        gid: ctx.message.chat.id.toString(),
                        gname: encodeURIComponent(ctx.message.chat.title),
                    },
                },
                process.env.JWT_SECRET
            );

            const msg = `Dear <a href="tg://user?id=${user.id.toString()}">${escapeHtml(
                user.first_name
            )}</a>, with our Anti-SPAM policy, we kindly inform you that you need to click the following button to prove your human identity.\n\nThis link will only valid in 10 minutes, please complete verification as soon as possible, thanks for your cooperation.`;
            ctx.telegram.editMessageText(ctx.message.chat.id, message_id, undefined, msg, {
                parse_mode: 'HTML',
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [
                            {
                                text: 'Go to verification page',
                                url: 'https://tg-recaptcha.github.io/#' + jwtoken + ';' + bot.options.username + ';' + process.env.G_SITEKEY,
                            },
                        ],
                    ],
                }),
            });
        });

    return 0;
});

async function verifyUser(payload, ctx) {
    try {
        const requestInfo = jwt.verify(payload.jwt, process.env.JWT_SECRET);
        if (requestInfo.data.uid !== ctx.message.from.id.toString()) {
            throw new Error("You can't verify account for another person. (`" + requestInfo.data.uid + '`, `' + ctx.message.from.id + '`)');
        }

        const response = await request.post({
            url: 'https://www.google.com/recaptcha/api/siteverify',
            form: {
                secret: process.env.G_SECRETKEY,
                response: payload.gresponse,
            },
            resolveWithFullResponse: true,
        });
        if (response && response.statusCode !== 200) {
            throw new Error(
                'Error when trying to connect Google verification servers, you may try to use the backup method shown in verify page or just rest for a while and try again.\n' + 'Status code: ' + (response && response.statusCode)
            );
        }

        const result = JSON.parse(response.body);
        if (!result.success) {
            throw new Error("Sorry, but we can't verify you now. You may like to quit and rejoin the group and try again.");
        }

        ctx.telegram.restrictChatMember(requestInfo.data.gid, requestInfo.data.uid, {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
        });
        // ctx.telegram.deleteMessage(requestInfo.data.gid, requestInfo.data.mid);
        ctx.telegram.editMessageText(requestInfo.data.gid, requestInfo.data.mid, undefined, `Passed. Verification takes: \`${Math.floor(new Date() / 1000) - requestInfo.iat}s\``, {
            parse_mode: 'markdown',
            reply_markup: JSON.stringify({
                inline_keyboard: [],
            }),
        });
        ctx.replyWithHTML(`Congratulations~ We already verified you, now you can enjoy your chatting with <code>${escapeHtml(decodeURIComponent(requestInfo.data.gname))}</code>'s members!`);
        return 0;
    } catch (err) {
        let msg = "Sorry, but we can't verify you now. You may like to quit and rejoin the group and try again.\n\n" + 'Technical details: ```' + err + '```';
        if (err.__proto__.toString() === 'Error' && err.message) {
            msg = err.message;
        }
        ctx.replyWithMarkdown(msg);
        return 1;
    }
}

exports.handler = (event, ctx, callback) => {
    updateHandler(event, callback);
};

if (!(process.env.LAMBDA_TASK_ROOT && process.env.AWS_EXECUTION_ENV)) {
    console.log('Start Polling...');
    bot.startPolling();
}
