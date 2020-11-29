const schedule = require('node-schedule');
const yargs = require('yargs');

const frontend = require("./frontend.js");
const backend = require("./backend.js");

async function main() {
    var argv = yargs.argv;

    await backend.openDB();

    if (argv.init) {
        await backend.initializeDB();
    } else if (argv.ignoreNewPosts) {
        await backend.ignoreNewPosts();
    } else if (argv.forceVouch) { 
        await backend.forceVouch();
    } else {
        console.log("No valid args found. Starting up in standard mode.");
        frontend.setDB(backend.getDB());
        frontend.startServer(9002);

        schedule.scheduleJob('* * * * *', backend.processNewPosts);
        schedule.scheduleJob('*/3 * * * *', backend.processTradeThread);
        schedule.scheduleJob('1 0 1,15 * *', backend.makeTradeThread);
        schedule.scheduleJob('1 0 1 * *', backend.makeCheckThread);
        console.log("OK, let's go!");
    }

}

main();