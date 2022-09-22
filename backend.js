'use strict';
const snoowrap = require('snoowrap');
const sqlite3 = require('sqlite3').verbose();
const sqliteWrap = require('sqlite');
//

const config = require(__dirname + '/config.json');

const r = new snoowrap({
    userAgent: 'canhwsbot/1.0.0 (by /u/NathanielHudson)',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken
});

const subredditName = config.subredditName;
const emtRepRequired = config.emtRepRequired;
var subredditModsCache = false;

/******************************************************************
******************** LOGGING
******************************************************************/


var logger = console;

function logFatalError(err) {
    // log error then exit
    logger.error(err);
    logger.log("Errors have been logged. ok goodbye now");
    process.exit(1);
}

process.on('uncaughtException', logFatalError);
process.on('unhandledRejection', logFatalError);

/******************************************************************
******************** DB INIT
******************************************************************/

var db;
async function openDB() {
    try {
        db = await sqliteWrap.open({
            filename: __dirname + '/chws.db',
            driver: sqlite3.Database
        });
        logger.debug('Connected to db.');
    } catch (err) {
        return logger.error(err.message);
    }
    return db;
};

function getDB() {
    return db;
}

async function initializeDB() {
    await db.run("CREATE TABLE misc (k TEXT PRIMARY KEY, v TEXT)");
    await db.run("CREATE TABLE vouches (user1 TEXT, user2 TEXT, permalink TEXT UNIQUE, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
    await db.run("CREATE TABLE posts (user TEXT, id TEXT PRIMARY KEY, title TEXT, body TEXT, permalink TEXT UNIQUE, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
}

/******************************************************************
******************** POST VALIDATION
******************************************************************/

async function processNewPosts() {
    var allPromises = [];

    var submissions = await r.getSubreddit(subredditName).getNew()
    for (let submission of submissions) {
        if (submission.author.name == "chwsbot") {
            continue;
        }

        allPromises.push(processNewPost(submission));
    }

    await Promise.all(allPromises);
    logger.debug("Done processing new posts.");
}

async function ignoreNewPosts() {
    var submissions = await r.getSubreddit(subredditName).getNew();

    for (let submission of submissions) {
        logger.debug("ignoring submission " + submission.title);
        await db.run(`INSERT INTO posts(user, id, body, title, permalink) VALUES(?, ?, ?, ?, ?)`, [submission.author.name, submission.id, submission.selftext, submission.title, submission.permalink]);
    }
}

async function processNewPost(submission) {
    var row = await db.get("SELECT EXISTS(SELECT 1 FROM posts WHERE id=?) AS exist", [submission.id]);
    if (row.exist == "1") { //we've seen this before.
        return false;
    };

    logger.debug("Processing submission " + submission.title);

    //okay, we havn't analyzed this post before. Get user info.
    var user = await submission.author.fetch();
    var row = await db.get("SELECT COUNT(ALL) AS rep FROM vouches WHERE user1 = ? OR user2 = ?", [user.name, user.name]);
    var rep = row['rep'];

    let postInfo = validateTitle(submission.title);
    validateBody(submission, postInfo);
    validateAuthor(user, postInfo);
    validateEMT(rep, submission, postInfo);

    if (postInfo.errors.length > 0 && submission.approved == false) {
        await submission.reply(`Hello!\n\nI've removed your post due to the following errors.\n\n* ${postInfo.errors.join("\n\n* ")}\n\n Please read the subreddit rules and try again. I'm just a bot, and I'm sorry if I got it wrong - if I did, please message the mods to let them know. Have a nice day!`);
        await submission.remove();
        return true;
    } else {
        var messageText;
        try {
            if (postInfo.type == "buy") {
                messageText = "Buying";
                await submission.selectFlair({ flair_template_id: 'd0ccd5d6-180d-11e4-9d57-12313d224df5' });
            } else if (postInfo.type == "sell") {
                messageText = "Selling";
                await submission.selectFlair({ flair_template_id: '99ca5616-1831-11e4-ac2a-12313b0e9a90' });
            } else if (postInfo.type == "trade") {
                messageText = "Trading";
                await submission.selectFlair({ flair_template_id: 'd50f0db2-180d-11e4-8ca0-12313b0ea137' });
            }
        } catch (err) {
            logger.error("Failed setting post fair. Probably a bad flair_template_id.");
        }

        var emtWarning = "";
        if (postInfo.wantsEMT) {
            emtWarning = "**Please note: OP has mentioned that they are interested in using EMT. Note that EMT transactions are NOT reversable in the event of a dispute or scam. Be extra careful if using EMT!**"
        }
        await submission.reply(`Username: ${user.name} ([History](http://chwsbot.nathanielh.com/user/${user.name}), [USL](https://universalscammerlist.com/search.php?username=${user.name})) \n\nConfirmed Trades: **${rep}**\n\nAccount Age: **${postInfo.accountAge}**\n\nKarma: **${user.link_karma + user.comment_karma}**\n\n${emtWarning}`).then(function (comment) { comment.distinguish({ status: true, sticky: true }); });

        var warningText = "";
        if (postInfo.warnings) {
            warningText = "\n\nPlease note:\n\n* " + postInfo.warnings.join("\n\n* ");
        }
        try {
            await r.composeMessage({
                to: user.name,
                subject: `Thank you for posting to /r/CanadianHardwareSwap!`,
                text: `Thank you for posting to /r/CanadianHardwareSwap. Based on your thread title I've automatically set your post's flair to **${messageText}**. If this is incorrect, please update your post's flair.${warningText}`
            });
        } catch {
            logger.error("Failed DMing user "+user.name+". They probably have DMs turned off.");
        }
        
        await db.run(`INSERT INTO posts(user, id, body, title, permalink) VALUES(?, ?, ?, ?, ?)`, [user.name, submission.id, submission.selftext, submission.title, submission.permalink]);
        await updateFlair(user);
        return true;
    }

}

function validateTitle(title) {
    var errors = [];
    var splitTitle = title.toLowerCase().split(/\[|\]/);
    var have, want, type;

    //basic sanity testing
    if (splitTitle[0].trim() != "" || splitTitle[2].trim() != "" || splitTitle[3] != "h" || splitTitle[5] != "w") {
        errors.push("Title format is incorrect - please make sure your title uses the \"[Location][H] What you have [W] What you want\" format.");
    } else {
        //passed sanity, do the thing
        have = splitTitle[4];
        var haveMoney = have.match(/cash|money|paypal|emt|emf|bitcoin|interac|etransfer|e-transfer/i);
        want = splitTitle[6];
        var wantMoney = want.match(/cash|money|paypal|emt|emf|bitcoin|interac|etransfer|e-transfer/i);

        if (haveMoney && !wantMoney) {
            type = "buy";
        } else if (wantMoney && !haveMoney) {
            type = "sell";
        } else {
            type = "trade";
        }
    }

    return {
        errors: errors,
        warnings: [],
        have: have,
        want: want,
        type: type
    }
}

function validateBody(submission, postInfo) {
    if (postInfo.type == "sell" || postInfo.type == "trade") {
        //scan for timestamp
        var timestamps = submission.selftext.match(/imgur.com|i.reddit.com|i.redd.it|cdn.discordapp.com|dropbox.com|drive.google.com|photos.google.com|flickr.com|ibb.co|gyazo.com|puu.sh|prntscr.com|postimg.org|tinypic.com/i);
        if (!timestamps) {
            if (postInfo.type == "sell") {
                postInfo.errors.push("Your submission appears to be a selling thread that lacks a timestamp picture. For best results please use imgur.");
            } else {
                postInfo.errors.push("Your submission appears to be a trading thread that lacks a timestamp picture. For best results please use imgur.");
            }
        }
        postInfo.warnings.push("Any user who DMs you without first commenting on your post may be a scammer trying to evade our ban list. Please let the mod team know if this happens.");
    }

    var prices = submission.selftext.match(/\$|CAD|USD|pay/i);
    if (!prices) {
        if (postInfo.type == "buy") {
            postInfo.warnings.push("The bot wasn't able to identify a buying price in your post. We require buying posts to include the approximate price they're hoping to pay. If your post doesn't include a price please edit one in. If you've already included a price - great, ignore this warning.");
        }
        if (postInfo.type == "sell") {
            postInfo.warnings.push("The bot wasn't able to identify a selling price in your post. We require selling posts to include a price. If your post doesn't include a price please edit one in. If you've already included a price - great, ignore this warning.");
        }
    }

    var offsiteLinks = submission.selftext.match(/kijiji.ca|craigslist.ca|kijiji.com|craigslist.com/i);
    if (offsiteLinks) {
        postInfo.errors.push("Your submission appears to contain a link to an offsite ad.");
    }
}

function validateEMT(rep, submission, postInfo) {
    var titleEMT = submission.title.match(/\b(emt|emf|bitcoin|interac|etransfer|e-transfer)\b/i);
    var bodyEMT = submission.selftext.match(/\b(emt|emf|bitcoin|interac|etransfer|e-transfer)\b/i);
    if (titleEMT || bodyEMT) {
        postInfo.wantsEMT = true;
        if (rep >= emtRepRequired) {
            postInfo.wantsEMT = true;
        } else {
            postInfo.errors.push("EMT, E-Transfer, Bitcoin and other electronic payment methods that do not have anti-scam prevention are banned for users with less than " + emtRepRequired + " confirmed trades. Instead, we require that you use *PayPal Goods and Services* for non-local swaps. If your post says that you are only looking for EMT for local swaps please message the mods and ask us to manually approve your post.");
        }
    }
}

function validateAuthor(user, postInfo) {
    var delta = new Date().getTime() - user.created_utc * 1000;
    if (delta < 28 * 24 * 60 * 60 * 1000) {
        postInfo.errors.push("We require posting accounts to be at least 30 days old.");
    }
    postInfo.accountAge = millisecondsToStr(delta);
}


/******************************************************************
************* CREATE CONFIRMED TRADE THREADS
******************************************************************/

async function makeTradeThread() {
    var row = await db.get("SELECT * FROM misc WHERE k = ?", ["tradeThreadID"]);
    if (row) {
        await db.run(`REPLACE INTO misc(k, v) VALUES(?, ?)`, ["prevTradeThreadID", row.v]);
    }

    var tradeThread = await r.getSubreddit(subredditName).submitSelfpost({
        title: 'Confirmed Trade Thread' + getThreadDate(true), text: 'Post your confirmed trades below.\n\n To confirm a trade: User1 should create a comment tagging User2. User2 then replies to that comment with "Confirmed".'
            + '\n\nConfirming non-CanadianHardwareSwap trades, farming trades, or any other shenanigans will result in an immediate ban. '
            + '**Please only confirm trades once both parties have their items in-hand (Don\'t confirm before you\'ve actually recived your package).**'
            + '\n\nPosting what prices things sold for is highly encouraged.'
            + '\n\nStay safe, and happy swapping!'
    }).sticky().approve();

    try {
        await tradeThread.selectFlair({ flair_template_id: '7a742520-840f-11e6-b719-0e11fe917ecf' });
    } catch (err) {
        logger.log("Setting tradeThread flair failed. Probably a bad flair_template_id.");
    }

    var id = await tradeThread.id;
    await db.run(`REPLACE INTO misc(k, v) VALUES(?, ?)`, ["tradeThreadID", id]);
}

/******************************************************************
************* PROCESS CONFIRMED TRADE THREADS
******************************************************************/

async function processTradeThread() {
    var row = await db.get("SELECT * FROM misc WHERE k = ?", ["tradeThreadID"]);
    if (row.v) {
        logger.log("Processing thread 1");
        await processTradeThreadByID(row.v);
    }

    var row = await db.get("SELECT * FROM misc WHERE k = ?", ["prevTradeThreadID"]);
    if (row.v) {
        logger.log("Processing thread 2");
        await processTradeThreadByID(row.v);
    }
}

async function processTradeThreadByID(ID) {
    logger.debug(`Looking at thread ${ID}.`);
    var comments = await r.getSubmission(ID).expandReplies({ limit: Infinity, depth: 3 }).comments;

    for (let comment of comments) {
        for (let reply of comment.replies) {

            var hasBotReplies = reply.replies.reduce((acc, val) => {
                return (acc || (val.author.name == "chwsbot"));
            }, false);

            if (
                reply.body.toLowerCase().includes("confirm")
                && comment.body.toLowerCase().includes(reply.author.name.toLowerCase())
                && reply.author.name != comment.author.name
            ) {
                if (!hasBotReplies) {
                    logger.debug("NEW TRADE");
                    await addVouch(comment.author, reply.author, comment.permalink, reply);
                }
            }
        }
    } //for comments

    logger.debug("Done processing trades.");
}

async function addVouch(user1, user2, permalink, replyto) {
    await db.run(`INSERT OR IGNORE INTO vouches(user1, user2, permalink) VALUES(?, ?, ?)`, [user1.name, user2.name, permalink]);
    if (user1.name != "nobody") {
        await updateFlair(user1);
    }
    if (user2.name != "nobody") {
        await updateFlair(user2);
    }
    if (replyto) {
        await replyto.reply(`Confirmed a trade between /u/${user1.name} and /u/${user2.name}.${personality()}`);
    }
}

async function updateFlair(user) {
    if (typeof user == "string") {
        user = await r.getUser(user);
    }
    var mods = await getSubredditMods();
    var isMod = false;
    var modFlair;

    for (let mod of mods) {
        if (mod.name.toLowerCase() == user.name.toLowerCase()) {
            isMod = true;
            if (mod.author_flair_text) {
                var flairParts = mod.author_flair_text.split('|');
                modFlair = flairParts[0].trim();
            } else {
                modFlair = "Mod";
            }
            break;
        }
    }


    var row = await db.get("SELECT COUNT(ALL) FROM vouches WHERE user1 = ? OR user2 = ?", [user.name, user.name]);
    var rep = row['COUNT(ALL)'];
    if (isMod && rep > 1) {
        await user.assignFlair({ subredditName: subredditName, text: modFlair, cssClass: "mod" });
    } else if (isMod && rep > 1) {
        await user.assignFlair({ subredditName: subredditName, text: modFlair + ' | ' + rep + ' Trades', cssClass: "mod" });
    } else if (rep == 0) {
        await user.assignFlair({ subredditName: subredditName, text: 'No Confirmed Trades', cssClass: "newuser" });
    } else if (rep == 1) {
        await user.assignFlair({ subredditName: subredditName, text: rep + ' Trade', cssClass: "user" });
    } else if (rep > 25) {
        await user.assignFlair({ subredditName: subredditName, text: rep + ' Trades! 🏆', cssClass: "poweruser" });
    } else if (rep > 15) {
        await user.assignFlair({ subredditName: subredditName, text: rep + ' Trades!', cssClass: "poweruser" });
    } else {
        await user.assignFlair({ subredditName: subredditName, text: rep + ' Trades', cssClass: "user" });
    }
}

/******************************************************************
************* UTILITY
******************************************************************/

function personality() {
    if (Math.random() > 0.2) {
        return "";
    }
    var items = [
        "Merci!", "Thank you!", "Thank you!", "Thanks!", "Watch out for moose.", "Thanks for using CHWS!", "Have a good one!", "Have a nice day!",
        "Have a nice day!", "Buy Igloo insurance!", "The best milk comes in bags.", "Buy me a house hippo.", "The robot uprising is imminent!",
        "🍁", "🍁", "🍁🍁🍁", "I live on a Raspberry Pi!"
    ];
    return " " + items[Math.floor(Math.random() * items.length)];
}

async function getSubredditMods() {
    //basically so we don't make this request every time we update flair.
    if (subredditModsCache === false) {
        subredditModsCache = await r.getSubreddit(subredditName).getModerators();
    }
    return subredditModsCache;
}


function millisecondsToStr(elapsed) {
    var msPerMinute = 60 * 1000;
    var msPerHour = msPerMinute * 60;
    var msPerDay = msPerHour * 24;
    var msPerMonth = msPerDay * 30;
    var msPerYear = msPerDay * 365;

    if (elapsed < msPerMinute) {
        return Math.round(elapsed / 1000) + ' seconds';
    } else if (elapsed < msPerHour) {
        return Math.round(elapsed / msPerMinute) + ' minutes';
    } else if (elapsed < msPerDay) {
        return Math.round(elapsed / msPerHour) + ' hours';
    } else if (elapsed < msPerMonth) {
        return Math.round(elapsed / msPerDay) + ' days';
    } else if (elapsed < msPerYear) {
        return Math.round(elapsed / msPerMonth) + ' months';
    } else {
        return Math.round(elapsed / msPerYear) + ' years';
    }
}

async function forceVouch(user) {
    if (typeof user != "string") {
        logger.log("Need a username for forceVouch");
    } else {
        logger.log("Forcing vouch for " + user);
        await addVouch(r.getUser(user), { name: "nobody" }, "Override_" + Math.floor(Math.random() * 10000), false);
    }
}

function getThreadDate(includeDay) {
    //bad function name, gets the "For June 2019" or whatever that goes in sticky titles
    var d = new Date();
    var months = ["January", "Febuary", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var day = "";
    if (includeDay) {
        day = " " + d.getDate();
    }
    return " - " + months[d.getMonth()] + day + " " + d.getFullYear();
}

async function makeCheckThread() {
    var checkThread = await r.getSubreddit(subredditName).submitSelfpost({
        title: 'Price Check Thread' + getThreadDate(false), text: `Get your hardware appraised here!\n`
            + `Please consider sorting the comments by "new" (instead of "best" or "top") to see the newest posts.\n`
            + `Alternatively, join the CanadianHardwareSwap Discord, which includes a price check channel - https://discord.gg/tMaF8d7`
    }).sticky().approve();

    try {
        await checkThread.selectFlair({ flair_template_id: '7a742520-840f-11e6-b719-0e11fe917ecf' });
    } catch (err) {
        logger.log("Setting checkThread flair failed. Probably a bad flair_template_id.");
    }
}

/******************************************************************
************* EXPORTS
******************************************************************/

exports.initializeDB = initializeDB;
exports.openDB = openDB;
exports.processTradeThread = processTradeThread;
exports.makeTradeThread = makeTradeThread;
exports.makeCheckThread = makeCheckThread;
exports.processNewPosts = processNewPosts;
exports.ignoreNewPosts = ignoreNewPosts;
exports.forceVouch = forceVouch;
exports.updateFlair = updateFlair;
exports.getDB = getDB;




