require('dotenv').config();
const request = require('request');
const jwt = require('jsonwebtoken');
const Telegraf = require('telegraf');
const telegrafAws = require('telegraf-aws');
const commandParts = require('telegraf-command-parts');

const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: {
        webhookReply: false
    }
});

bot.use(commandParts());

bot.telegram.getMe().then((botInfo) => {
    bot.options.username = botInfo.username;
});

const updateHandler = telegrafAws(bot, {
    timeout: 3000
});

bot.telegram.setWebhook(process.env.BOT_WEBHOOK_URL);

bot.command('start', async (ctx) => {
    if (ctx.message.chat.type !== "private") {
        return 0;
    }
    const pasteID = ctx.state.command.args;
    if (!pasteID) {
        ctx.telegram.webhookReply = true;
        ctx.reply("This bot is only using to verify machine-generated code, you may check out https://github.com/TG-reCAPTCHA/Telegram-reCAPTCHA-Bot for more information.");
        return 1;
    }
    
    request('https://bytebin.lucko.me/' + pasteID, (error, response, body) => {
        if (error || (response && (response.statusCode !== 200))) {
            ctx.replyWithMarkdown("Error when trying to retrieve payload from Pastebin, you may try to use the backup method provided in the verification page or just rest for a while and try again.\nTechnical details: `" + error + "`\nStatus code: " + (response && response.statusCode));
            return 1;
        }

        try {
            const payload = JSON.parse(body);
            if (!payload || !payload.jwt || !payload.gresponse) {
                ctx.reply("Invalid data from Pastebin, please try again later or use the backup method provided in the verification page.");
                return 1;
            }
            return verifyUser(payload, ctx);
        } catch (err) {
            ctx.reply("Invalid data from Pastebin, please try again later or use the backup method provided in the verification page.");
        }
    });

});

bot.command('verify', (ctx) => {
    if (ctx.message.chat.type !== "private") {
        return 0;
    }

    if (!ctx.state.command.args) {
        ctx.reply("This bot is only using to verify machine-generated code, you may check out https://github.com/TG-reCAPTCHA/Telegram-reCAPTCHA-Bot for more information.");
        return 1;
    }

    try {
        const payload = JSON.parse(new Buffer(ctx.state.command.args, 'base64').toString());
        if (!payload || !payload.jwt || !payload.gresponse) {
            ctx.telegram.webhookReply = true;
            ctx.reply("Invalid data, please try again later.");
            return 1;
        }
        return verifyUser(payload, ctx);
    } catch (err) {
        ctx.telegram.webhookReply = true;
        ctx.reply("Invalid data, please try again later.");
        return 1;
    }

});

bot.on('new_chat_members', async (ctx) => {
    ctx.message.new_chat_members.filter(({
        is_bot
    }) => !is_bot).forEach(user => {
        ctx.telegram.restrictChatMember(ctx.message.chat.id, user.id);
    });

    ctx.message.new_chat_members.filter(({
        is_bot
    }) => !is_bot).forEach(async user => {
        const {
            message_id
        } = await ctx.reply("Processing...");

        const jwtoken = jwt.sign({
            exp: Math.floor(Date.now() / 1000) + (60 * 10),
            data: {
                mid: message_id,
                uid: user.id.toString(),
                gid: ctx.message.chat.id.toString(),
                gname: encodeURIComponent(ctx.message.chat.title)
            }
        }, process.env.JWT_SECRET);

        const msg = "Dear [" + user.first_name + "](tg://user?id=" + user.id.toString() + "), with our Anti-SPAM policy, we kindly inform you that you need to click the following button to prove your human identity.\n\nThis link will only valid in 10 minutes, please complete verification as soon as possible, thanks for your cooperation.";
        ctx.telegram.editMessageText(ctx.message.chat.id, message_id, undefined, msg, {
            parse_mode: "markdown",
            reply_markup: JSON.stringify({
                "inline_keyboard": [
                    [{
                        "text": "Go to verification page",
                        "url": "https://tg-recaptcha.github.io/#" + jwtoken + ";" + bot.options.username + ";" + process.env.G_SITEKEY
                    }]
                ]
            })
        });
    });

    return 0;
});

function verifyUser(payload, ctx) {
    try {
        const requestInfo = jwt.verify(payload.jwt, process.env.JWT_SECRET);

        if (requestInfo.data.uid !== ctx.message.from.id.toString()) {
            ctx.replyWithMarkdown("You can't verify account for other person. (`" + requestInfo.data.uid + "`, `" + ctx.message.from.id + "`)");
            return 1;
        }

        request.post({
            url: 'https://www.google.com/recaptcha/api/siteverify',
            form: {
                secret: process.env.G_SECRETKEY,
                response: payload.gresponse
            }
        }, (error, response, body) => {
            if (error || (response && (response.statusCode !== 200))) {
                ctx.replyWithMarkdown("Error when trying to connect Google verification servers, you may try to use the backup method shown in verify page or just rest for a while and try again.\nTechnical details: `" + error + "`\nStatus code: " + (response && response.statusCode));
                return 1;
            }
            const result = JSON.parse(body);
            if (result.success) {
                ctx.telegram.restrictChatMember(requestInfo.data.gid, requestInfo.data.uid, {
                    "can_send_messages": true,
                    "can_send_media_messages": true,
                    "can_send_other_messages": true,
                    "can_add_web_page_previews": true
                });

                ctx.telegram.deleteMessage(requestInfo.data.gid, requestInfo.data.mid);

                ctx.replyWithMarkdown("Congratulations~ We already verified you, now you can enjoy your chatting with `" + decodeURIComponent(requestInfo.data.gname) + "`'s members!");
                return 0;
            } else {
                ctx.replyWithMarkdown("Sorry, but we can't verify you now. You may like to quit and rejoin the group and try again.");
                return 1;
            }
        });
    } catch (err) {
        ctx.replyWithMarkdown("Sorry, but we can't verify you now. You may like to quit and rejoin the group and try again.\n\nTechnical details: ```" + err + "```");
        return 1;
    }
}

exports.handler = (event, ctx, callback) => {
    updateHandler(event, callback);
};