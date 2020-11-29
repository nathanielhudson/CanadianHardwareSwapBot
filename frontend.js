var http = require("http");
var fs = require("fs");
var db;

var spa = "Failed to load SPA"; //cache single page app to string
fs.readFile("frontend.html", "utf8", function (err, data) {
    if (err) {
        console.log(err);
    }
    spa = data;
});

function serveUserPage(res) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(spa);
    res.end();
}

async function serveUserData(username, res) {
    res.writeHead(200, { "Content-Type": "text/json" });
    var postrows = await db.all("SELECT * FROM posts WHERE user=? ORDER BY timestamp DESC", [username]);
    var vouchrows = await db.all("SELECT * FROM vouches WHERE user1 = ? OR user2 = ? ORDER BY timestamp DESC", [username, username]);
    var result = { name: username, posts: postrows, vouches: vouchrows };
    res.write(JSON.stringify(result));
    res.end();
}

async function serveVouchData(res) {
    res.writeHead(200, { "Content-Type": "text/json" });
    var vouchrows = await db.all("SELECT * FROM vouches");
    var result = { vouches: vouchrows };
    res.write(JSON.stringify(result));
    res.end();
}

exports.startServer = function(port) {
    http.createServer(async function (req, res) {
        //just writing my own router since this is so minimal...
        if (req.url.startsWith("/user/") || req.url.startsWith("/overview")) {
            serveUserPage(res);
        } else if (req.url.startsWith("/api/user/")) {
            var arg = req.url.replace("/api/user/", "");
            await serveUserData(arg, res);
        } else if (req.url.startsWith("/api/vouches/")) {
            await serveVouchData(res);
        } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.write("404 not found for " + req.url);
            res.end();
        }
    
        req.on('error', err => {
            console.error(err);
            // Handle error...
            res.statusCode = 400;
            res.end('400: Bad Request');
            return;
        });
    
        res.on('error', err => {
            console.error(err);
            // Handle error...
        });
    }).listen(port);
}

exports.setDB = function(_db) {
    db = _db;
};