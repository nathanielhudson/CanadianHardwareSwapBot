var http = require("http");
var fs = require("fs");
const sqlite3 = require('sqlite3').verbose();

var spa = "Failed to load SPA"; //cache single page app to string
fs.readFile("frontend.html", "utf8", function (err, data) {
    if (err) {
        console.log(err);
    }
    spa = data;
});

let db = new sqlite3.Database(__dirname + '/chws.db', (err) => {
    if (err) {
        return console.log(err.message);
    }
    console.log('Connected to db.');
});


function serveUserPage(res) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write(spa);
    res.end();
}

function serveUserData(username, res) {
    res.writeHead(200, { "Content-Type": "text/json" });
    db.all("SELECT * FROM posts WHERE user=? ORDER BY timestamp DESC", [username], (err, postrows) => {
        db.all("SELECT * FROM vouches WHERE user1 = ? OR user2 = ? ORDER BY timestamp DESC", [username, username], (err, vouchrows) => {
            var result = { name: username, posts: postrows, vouches: vouchrows };
            res.write(JSON.stringify(result));
            res.end();
        });
    });
}

function serveVouchData(res) {
    res.writeHead(200, { "Content-Type": "text/json" });
    db.all("SELECT * FROM vouches", [], (err, vouchrows) => {
        var result = { vouches: vouchrows };
        res.write(JSON.stringify(result));
        res.end();
    });
}

http.createServer(function (req, res) {
    //just writing my own router since this is so minimal...
    if (req.url.startsWith("/user/") || req.url.startsWith("/overview")) {
        serveUserPage(res);
    } else if (req.url.startsWith("/api/user/")) {
        var arg = req.url.replace("/api/user/", "");
        serveUserData(arg, res);
    } else if (req.url.startsWith("/api/vouches/")) {
        serveVouchData(res);
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
}).listen(26632);
