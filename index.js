require('dotenv').config();
const jwt = require('jsonwebtoken');
const Telegraf = require('telegraf');
const CryptoJS = require('crypto-js');
const escapeHtml = require('escape-html');
const request = require('request-promise');
const Session = require('telegraf/session');
const telegrafAws = require('telegraf-aws');
const commandParts = require('telegraf-command-parts');
const DynamoDBSession = require('telegraf-session-dynamodb');

const isLambda = !!(process.env.LAMBDA_TASK_ROOT && process.env.AWS_EXECUTION_ENV);

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        webhookReply: false,
    },
});

bot.use(commandParts());

if (isLambda) {
    const dynamoDBSession = new DynamoDBSession({
        dynamoDBConfig: {
            params: {
                TableName: process.env.AWS_DYNAMODB_TABLE,
            },
            region: process.env.AWS_REGION,
        },
        ttl: 604800,
    });
    bot.use(dynamoDBSession.middleware());
} else {
    bot.use(
        Session({
            ttl: 604800,
        })
    );
}

bot.telegram.getMe().then((botInfo) => {
    bot.options.username = botInfo.username;
    bot.options.bid = botInfo.id;
});

const updateHandler = telegrafAws(bot, {
    timeout: 3000,
});

const invitedUser = new Map();

bot.command('start', async (ctx) => {
    if (ctx.message.chat.type !== 'private') {
        return 0;
    }

    try {
        if (isRateLimited(ctx)) {
            return 1;
        }

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

        let payload;
        try {
            payload = JSON.parse(CryptoJS.AES.decrypt(response.body, ctx.message.from.id.toString()).toString(CryptoJS.enc.Utf8));
        } catch (error) {
            payload = JSON.parse(CryptoJS.AES.decrypt(response.body, 'Public Invitation').toString(CryptoJS.enc.Utf8));
        }

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
        } else {
            console.log(err);
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
        if (isRateLimited(ctx)) {
            return 1;
        }

        if (!ctx.state.command.args) {
            ctx.telegram.webhookReply = true;
            throw new Error('This bot is only using to verify machine-generated code, you may check out https://github.com/TG-reCAPTCHA/Telegram-reCAPTCHA-Bot for more information.');
        }

        const payload = JSON.parse(Buffer.from(ctx.state.command.args, 'base64').toString());
        if (!payload || !payload.jwt || !payload.gresponse) {
            ctx.telegram.webhookReply = true;
            throw new Error();
        }

        return await verifyUser(payload, ctx);
    } catch (err) {
        let msg = 'Invalid data, please try again later.';
        if (err.__proto__.toString() === 'Error' && err.message) {
            msg = err.message;
        } else {
            console.log(err);
        }
        ctx.replyWithMarkdown(msg);
        return 1;
    }
});

bot.on('callback_query', async (ctx) => {
    const member = await ctx.telegram.getChatMember(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.from.id);
    if (!member || !(member.status === 'creator' || (member.status === 'administrator' && member.can_invite_users))) {
        return 0;
    }
    const requestInfo = JSON.parse(ctx.callbackQuery.data);
    switch (requestInfo.action) {
        case 'invite': {
            if (!requestInfo.expire || requestInfo.expire > 30 || requestInfo.expire < 1) {
                return 0;
            }
            const jwtoken = jwt.sign(
                {
                    exp: Math.floor(Date.now() / 1000) + requestInfo.expire * 86400,
                    data: {
                        invite: true,
                        uid: 'Public Invitation',
                        gid: ctx.callbackQuery.message.chat.id.toString(),
                        gname: encodeURIComponent(ctx.callbackQuery.message.chat.title),
                    },
                },
                process.env.JWT_SECRET
            );

            console.log(
                JSON.stringify({
                    time: getTimeStamp(),
                    event: 'newInviteTokenIssued',
                    gid: CryptoJS.MD5(ctx.callbackQuery.message.chat.id.toString()).toString(),
                })
            );

            const msg = 'Generated. Your invite link:\n<code>' + 'https://tg-recaptcha.github.io/#' + jwtoken + ';' + bot.options.username + ';' + process.env.G_SITEKEY + '</code>';
            ctx.telegram.editMessageText(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id, undefined, msg, {
                parse_mode: 'HTML',
                reply_markup: JSON.stringify({
                    inline_keyboard: [[]],
                }),
            });

            break;
        }
        default:
            break;
    }
    // ctx.answerCbQuery("Generated.", true);
});

bot.command('invite', async (ctx) => {
    if (ctx.message.chat.type !== 'supergroup') {
        return 0;
    }

    try {
        if (isRateLimited(ctx)) {
            return 1;
        }

        if (isLambda) {
            throw new Error('Invite feature is currently not support Lambda.');
        }

        const member = await ctx.telegram.getChatMember(ctx.message.chat.id, ctx.message.from.id);
        if (!member || !(member.status === 'creator' || (member.status === 'administrator' && member.can_invite_users))) {
            throw new Error('You have no permission to invite users.');
        }

        const botRights = await ctx.telegram.getChatMember(ctx.message.chat.id, bot.options.bid);
        if (botRights && botRights.can_invite_users === false) {
            throw new Error('I have no permission to invite users.');
        }

        if (!ctx.state.command.splitArgs[0] || ctx.state.command.splitArgs[0] > 30 || ctx.state.command.splitArgs[0] < 1) {
            throw new Error('Usage: /invite <Valid>\n\nValid: Generated link is valid for how many days, between 1 and 30.');
        }

        ctx.telegram.sendMessage(ctx.message.chat.id, `Please noticed that we <b>UNABLE TO REVOKE THE INVITE LINK</b> for you. Are you sure you want to generate an invite link valid for ${ctx.state.command.splitArgs[0]}day(s)?`, {
            parse_mode: 'HTML',
            reply_to_message_id: ctx.message.message_id,
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [
                        {
                            text: `Sure, generate a link valid for ${ctx.state.command.splitArgs[0]}day(s).`,
                            callback_data: JSON.stringify({ action: 'invite', expire: ctx.state.command.splitArgs[0] }),
                        },
                    ],
                ],
            }),
        });
    } catch (err) {
        let msg = 'Error when trying to generate an invite link.';
        if (err.__proto__.toString() === 'Error' && err.message) {
            msg = err.message;
        } else {
            console.log(err);
        }
        ctx.replyWithMarkdown(msg, {
            reply_to_message_id: ctx.message.message_id,
        });
        return 1;
    }
});

bot.on('new_chat_members', async (ctx) => {
    ctx.message.new_chat_members
        .filter(({ is_bot }) => !is_bot)
        .filter(({ id }) => !invitedUser.has(id) || invitedUser.get(id) !== ctx.message.chat.id.toString())
        .forEach((user) => {
            ctx.telegram.restrictChatMember(ctx.message.chat.id, user.id);
        });

    // Pre-reply user joins message, record message id to JWT for subsequent deletion operation.
    ctx.message.new_chat_members
        .filter(({ is_bot }) => !is_bot)
        .filter(({ id }) => {
            if (invitedUser.has(id) && invitedUser.get(id) === ctx.message.chat.id.toString()) {
                setTimeout(() => {
                    invitedUser.delete(id);
                }, 5000);
                return false;
            } else {
                return true;
            }
        })
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

            console.log(
                JSON.stringify({
                    time: getTimeStamp(),
                    event: 'newVerifyTokenIssued',
                    gid: CryptoJS.MD5(ctx.message.chat.id.toString()).toString(),
                })
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
        if (!requestInfo.data.invite && requestInfo.data.uid !== ctx.message.from.id.toString()) {
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

        if (requestInfo.data.invite) {
            const inviteLink = await ctx.telegram.exportChatInviteLink(requestInfo.data.gid);
            invitedUser.set(ctx.message.from.id, requestInfo.data.gid);
            ctx.telegram.sendMessage(ctx.message.chat.id, `Congratulations~ We already verified you, you can join the group <code>${escapeHtml(decodeURIComponent(requestInfo.data.gname))}</code> now!`, {
                parse_mode: 'HTML',
                reply_to_message_id: ctx.message.message_id,
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [
                            {
                                text: `Join ${escapeHtml(decodeURIComponent(requestInfo.data.gname))}`,
                                url: inviteLink,
                            },
                        ],
                    ],
                }),
            });
            console.log(
                JSON.stringify({
                    time: getTimeStamp(),
                    event: 'InviteSuccess',
                    gid: CryptoJS.MD5(requestInfo.data.gid).toString(),
                })
            );
        } else {
            await ctx.telegram.restrictChatMember(requestInfo.data.gid, requestInfo.data.uid, {
                can_send_messages: true,
                can_send_media_messages: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
            });
            ctx.telegram.deleteMessage(requestInfo.data.gid, requestInfo.data.mid);
            const duration = getTimeStamp() - requestInfo.iat;
            // ctx.telegram.editMessageText(requestInfo.data.gid, requestInfo.data.mid, undefined, `Passed. Verification takes: \`${duration}s\``, {
            //     parse_mode: 'markdown',
            //     reply_markup: JSON.stringify({
            //         inline_keyboard: [],
            //     }),
            // });
            ctx.replyWithHTML(`Congratulations~ We already verified you, now you can enjoy your chatting with <code>${escapeHtml(decodeURIComponent(requestInfo.data.gname))}</code>'s members!`);
            console.log(
                JSON.stringify({
                    time: getTimeStamp(),
                    event: 'VerifySuccess',
                    gid: CryptoJS.MD5(requestInfo.data.gid).toString(),
                    duration: duration,
                })
            );
        }

        return 0;
    } catch (err) {
        let msg = "Sorry, but we can't verify you now. You may like to quit and rejoin the group and try again.\n\n" + 'Technical details: ```' + err + '```';
        if (err.__proto__.toString() === 'Error' && err.message) {
            msg = err.message;
        } else {
            console.log(err);
        }
        ctx.replyWithMarkdown(msg);
        return 1;
    }
}

function isRateLimited(ctx) {
    const gap = getTimeStamp() - (ctx.session.lastRequest || getTimeStamp() - 60);
    if (gap < 10) {
        console.log(
            JSON.stringify({
                time: getTimeStamp(),
                event: 'ignoredRequest',
                uid: CryptoJS.MD5(ctx.message.from.id.toString()).toString(),
                lastRequest: ctx.session.lastRequest,
                gap: gap,
            })
        );
        ctx.session.lastRequest = getTimeStamp();
        return true;
    } else if (gap < 30) {
        console.log(
            JSON.stringify({
                time: getTimeStamp(),
                event: 'ignoredRequestWithNotice',
                uid: CryptoJS.MD5(ctx.message.from.id.toString()).toString(),
                lastRequest: ctx.session.lastRequest,
                gap: gap,
            })
        );
        throw new Error(`Too many requests! Please wait for ${30 - gap}s.`);
    }
    ctx.session.lastRequest = getTimeStamp();
    return false;
}

function getTimeStamp() {
    return Math.round(new Date().getTime() / 1000);
}

exports.handler = (event, ctx, callback) => {
    updateHandler(event, callback);
};

if (!isLambda) {
    console.log('Start Polling...');
    bot.startPolling();
}
