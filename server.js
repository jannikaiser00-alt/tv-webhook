const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const SECRET = process.env.TV_SECRET || "default_secret";

app.post("/hook", (req, res) => {
    const { secret, cmd } = req.body;

    if (secret !== SECRET) {
        return res.status(403).send({ error: "Unauthorized" });
    }

    console.log("TradingView command received:", cmd);
    res.send({ status: "ok" });
});

app.get("/", (req, res) => {
    res.send("Webhook server is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
