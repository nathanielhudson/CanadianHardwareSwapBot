'use strict';
const snoowrap = require('snoowrap');
const sqlite3 = require('sqlite3').verbose();
const yargs = require('yargs');
var log4js = require('log4js');

const config = require(__dirname + '/config.json');

const r = new snoowrap({
    userAgent: 'canhwsbot/1.0.0 (by /u/NathanielHudson)',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken
});

const subredditName = config.subredditName;
const emtRepRequired = config.emtRepRequired;

/******************************************************************
******************** LOGGING
******************************************************************/

log4js.configure({
    appenders: { everything: { type: 'file', filename: __dirname + '/log/chwsbot.log' } },
    categories: { default: { appenders: ['everything'], level: 'debug' } }
});
var logger = log4js.getLogger();
logger.level = 'debug';

process.on('uncaughtException', function(err) {
    // log error then exit
    console.log(err);
    logger.fatal(err);
    log4js.shutdown(function() {
        console.log("Errors have been logged. ok goodbye now");
        process.exit(1);
    });
});

/******************************************************************
******************** DB INIT
******************************************************************/

let db = new sqlite3.Database(__dirname + '/chws.db', (err) => {
    if (err) {
        return logger.error(err.message);
    }
    logger.debug('Connected to db.');
});

function initializeDB() {
    db.run("CREATE TABLE misc (k TEXT PRIMARY KEY, v TEXT)");
    db.run("CREATE TABLE vouches (user1 TEXT, user2 TEXT, permalink TEXT UNIQUE, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE posts (user TEXT, id TEXT PRIMARY KEY, body TEXT, permalink TEXT UNIQUE, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
}

/******************************************************************
******************** POST VALIDATION
******************************************************************/

function processNewPosts() {
    var allPromises = [];
    return new Promise(function (mainResolve) {
        var getPosts = new Promise(function (getPostsResolve) {

            r.getSubreddit(subredditName).getNew().then(function (submissions) {
                for (let submission of submissions) {

                    if (submission.author.name == "chwsbot") {
                        continue;
                    }

                    allPromises.push(processNewPost(submission));
                }
                getPostsResolve();
            });

        });
        getPosts.then(function () {
            Promise.all(allPromises).then(function (values) {
                logger.debug("Done processing new posts.");
                mainResolve();
            });
        });
    });
}

function ignoreNewPosts() {
    r.getSubreddit(subredditName).getNew().then(function (submissions) {
        for (let submission of submissions) {
            logger.debug("ignoring submission " + submission.title);
            db.run(`INSERT INTO posts(user, id, body, permalink) VALUES(?, ?, ?, ?)`, [submission.author.name, submission.id, submission.selftext, submission.permalink], () => {
            });
        }
    });
}

function processNewPost(submission) {
    return new Promise(function (resolve, reject) {
        db.get("SELECT EXISTS(SELECT 1 FROM posts WHERE id=?) AS exist", [submission.id], (err, row) => {
            if (row.exist == "1") { //we've seen this before.
                resolve(false);
                return;
            };

            logger.debug("processing submission " + submission.title);

            //okay, we havn't analyzed this post before. Get user info.
            submission.author.fetch().then(function (user) {
                db.get("SELECT COUNT(ALL) AS rep FROM vouches WHERE user1 = ? OR user2 = ?", [user.name, user.name], (err, row) => {
                    var rep = row['rep'];
                    let postInfo = validateTitle(submission.title);
                    validateBody(submission, postInfo);
                    validateAuthor(user, postInfo);
                    validateEMT(rep, submission, postInfo);

                    if (postInfo.errors.length > 0) {
                        submission.reply(`Hello!\n\nI've removed your post due to the following errors.\n\n* ${postInfo.errors.join("\n\n* ")}\n\n Please read the subreddit rules and try again. I'm just a bot, and I'm sorry if I got it wrong - if I did, please message the mods to let them know. Have a nice day!`)
                        submission.remove();
                        resolve(true); //done
                    } else {
                        var messageText;
                        if (postInfo.type == "buy") {
                            submission.selectFlair({ flair_template_id: 'd0ccd5d6-180d-11e4-9d57-12313d224df5' });
                            messageText = "Buying";
                        } else if (postInfo.type == "sell") {
                            submission.selectFlair({ flair_template_id: '99ca5616-1831-11e4-ac2a-12313b0e9a90' });
                            messageText = "Selling";
                        } else if (postInfo.type == "trade") {
                            submission.selectFlair({ flair_template_id: 'd50f0db2-180d-11e4-8ca0-12313b0ea137' });
                            messageText = "Trading";
                        }
                        var emtWarning = "";
                        if (postInfo.wantsEMT) {
                            emtWarning = "**Please note: OP has mentioned that they are interested in using EMT. Note that EMT transactions are NOT reversable in the event of a dispute or scam. Be extra careful if using EMT!**"
                        }
                        submission.reply(`Username: ${user.name}\n\nConfirmed Trades: **${rep}**\n\nAccount Age: **${postInfo.accountAge}**\n\nKarma: **${user.link_karma + user.comment_karma}**\n\n${emtWarning}`).then(function (comment) { comment.distinguish({ status: true, sticky: true }); });
                        r.composeMessage({
                            to: user.name,
                            subject: `Thank you for posting to /r/CanadianHardwareSwap!`,
                            text: `Thank you for posting to /r/CanadianHardwareSwap. Based on your thread title I've automatically set your post's flair to **${messageText}**. If this is incorrect, please update your post's flair.`
                        });
                        db.run(`INSERT INTO posts(user, id, body, permalink) VALUES(?, ?, ?, ?)`, [user.name, submission.id, submission.selftext, submission.permalink], () => {
                            updateFlair(user).then(() => {
                                resolve(true); //done
                            });
                        });

                    }
                });

            });


        });
    });
}

function validateTitle(title) {
    var errors = [];
    var splitTitle = title.toLowerCase().split(/\[|\]/);
    var have, want, type;

    logger.debug(splitTitle);

    //basic sanity testing
    if (splitTitle[0].trim() != "" || splitTitle[2].trim() != "" || splitTitle[3] != "h" || splitTitle[5] != "w") {
        errors.push("Title format is incorrect - please make sure your title uses the \"[Location][H] What you have [W] What you want\" format.");
    } else {
        //passed sanity, do the thing
        have = splitTitle[4];
        var haveMoney = have.match(/cash|paypal|emt|emf|bitcoin/i);
        want = splitTitle[6];
        var wantMoney = want.match(/cash|paypal|emt|emf|bitcoin/i);

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
            postInfo.errors.push("Your submission appears to be a selling or trading thread that lacks a timestamp picture. For best results please use imgur.");
        }
    }
    var offsiteLinks = submission.selftext.match(/kijiji.ca|craigslist.ca|kijiji.com|craigslist.com/i);
    if (offsiteLinks) {
        postInfo.errors.push("Your submission appears to contain a link to an offsite ad.");
    }
}

function validateEMT(rep, submission, postInfo) {
    var titleEMT = submission.title.match(/emt|emf|bitcoin/i);
    var bodyEMT = submission.selftext.match(/emt|emf|bitcoin/i);
    if (titleEMT || bodyEMT) {
        postInfo.wantsEMT = true;
        if (rep >= emtRepRequired) {
            postInfo.wantsEMT = true;
        } else {
            postInfo.errors.push("EMT, Bitcoin and other electronic payment methods that do not have anti-scam prevention are banned for users with less than " + emtRepRequired + " confirmed trades.");
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

function makeTradeThread() {
    return new Promise(function (resolve) {
        var tradeThread = r.getSubreddit(subredditName).submitSelfpost({
            title: 'Confirmed Trade Thread', text: 'Post your confirmed trades below.\n\n To confirm a trade: User1 should create a comment tagging User2. User2 then replies to that comment with "Confirmed".'
                + '\n\nConfirming non-CanadianHardwareSwap trades, farming trades, or any other shenanigans will result in an immediate ban.'
                + '\n\nStay safe, and happy swapping!'
        }).sticky().approve().selectFlair({ flair_template_id: '7a742520-840f-11e6-b719-0e11fe917ecf' });
        tradeThread.id.then(function (id) {
            db.run(`REPLACE INTO misc(k, v) VALUES(?, ?)`, ["tradeThreadID", id]);
            resolve();
        });
    });
}

/******************************************************************
************* PROCESS CONFIRMED TRADE THREADS
******************************************************************/

function processTradeThread() {
    //TODO: Promise here is inacurate
    return new Promise(function (mainResolve) {
        db.get("SELECT * FROM misc WHERE k = ?", ["tradeThreadID"], (err, row) => {
            logger.debug(`Looking at thread ${row.v}.`);
            r.getSubmission(row.v).expandReplies({ limit: Infinity, depth: 3 }).comments.then(function (comments) {

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
                                addVouch(comment.author, reply.author, comment.permalink, reply);
                            }
                        }
                        /*else {
                            if (!hasBotReplies) {
                                reply.report({ reason: 'Bot says: Possible shenanigans in confirmed trade thread.' });
                                reply.reply(`Error: Something doesn't look right here...`);
                            }
                        }*/
                    }
                } //for comments

                logger.debug("Done processing trades.");
                mainResolve();

            });
        });
    }); //end Promise
}

function addVouch(user1, user2, permalink, replyto) {
    db.run(`INSERT INTO vouches(user1, user2, permalink) VALUES(?, ?, ?)`, [user1.name, user2.name, permalink], () => {
        updateFlair(user1);
        updateFlair(user2);
    });
    replyto.reply(`Confirmed a trade between /u/${user1.name} and /u/${user2.name}.${personality()}`);
}

function updateFlair(user) {
    return new Promise(function (resolve) {
        r.getSubreddit(subredditName).getModerators().then((mods) => {
            var isMod = false;

            for (let mod of mods) {
                if (mod.name.toLowerCase() == user.name.toLowerCase()) {
                    isMod = true;
                    break;
                }
            }

            if (!isMod) {
                db.get("SELECT COUNT(ALL) FROM vouches WHERE user1 = ? OR user2 = ?", [user.name, user.name], (err, row) => {
                    var rep = row['COUNT(ALL)'];
                    if (rep == 0) {
                        user.assignFlair({ subredditName: subredditName, text: 'No Confirmed Trades', cssClass: "newuser" });
                    } else if (rep == 1) {
                        user.assignFlair({ subredditName: subredditName, text: rep + ' Trade', cssClass: "user" });
                    } else if (rep > 25) {
                        user.assignFlair({ subredditName: subredditName, text: rep + ' Trades!', cssClass: "poweruser" });
                    } else {
                        user.assignFlair({ subredditName: subredditName, text: rep + ' Trades', cssClass: "user" });
                    }
                    resolve();
                });
            } else {
                //future enhancement - fancier mod flairs?
                logger.debug("Not flairing the mod!");
                resolve();
            }

        });
    });
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
        "🍁", "🍁", "🍁🍁🍁"
    ];
    return " " + items[Math.floor(Math.random() * items.length)];
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



async function main() {
    var argv = yargs.argv;

    if (argv.init) {
        initializeDB();
    }

    if (argv.processTradeThread) {
        await processTradeThread();
    }

    if (argv.makeTradeThread) {
        await makeTradeThread();
    }

    if (argv.processNewPosts) {
        await processNewPosts();
    }
    if (argv.ignoreNewPosts) {
        ignoreNewPosts();
    }
    logger.debug("Done running.");
}

main();
console.log("Done!");
